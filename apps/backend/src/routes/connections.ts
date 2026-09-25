import type { FastifyInstance } from 'fastify';
import { PROVIDERS } from '@wa/provider-connectors';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { one } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import * as svc from '../services/connections.js';
import { syncMissedEvents } from '../services/webhooks.js';

const idParam = z.object({ id: z.string().uuid() });

export async function connectionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/providers', async () =>
    PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: p.capabilities,
      partnerApiKeyConfigured: p.id === 'sendzen' ? !!ctx.config.SENDZEN_PARTNER_API_KEY : false,
    })),
  );
  app.get('/connections', async () => svc.listConnections(ctx));

  app.post('/connections', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(
      z.object({
        provider: z.enum(['sendzen']),
        label: z.string().min(1).max(100).default('SendZen'),
        mode: z.enum(['PRODUCTION', 'TEST']).default('PRODUCTION'),
        apiKey: z.string().min(8).max(500),
        webhookSecret: z.string().max(500).optional().nullable(),
        apiBaseUrl: z.string().url().optional().nullable(),
      }),
      req.body,
    );
    return svc.createConnection(ctx, body, req.user!.id);
  });

  app.patch('/connections/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        label: z.string().min(1).max(100).optional(),
        apiKey: z.string().min(8).max(500).optional(),
        webhookSecret: z.string().max(500).nullable().optional(),
        apiBaseUrl: z.string().url().nullable().optional().or(z.literal('')),
      }),
      req.body,
    );
    return svc.updateConnection(ctx, id, { ...body, apiBaseUrl: body.apiBaseUrl === '' ? null : body.apiBaseUrl }, req.user!.id);
  });

  app.get('/connections/:id/numbers', async (req) => svc.listProviderNumbers(ctx, parse(idParam, req.params).id));

  app.post('/connections/:id/select-number', async (req) => {
    const { id } = parse(idParam, req.params);
    const { phoneNumberId } = parse(z.object({ phoneNumberId: z.string().min(1) }), req.body);
    return svc.selectNumber(ctx, id, phoneNumberId, req.user!.id);
  });

  app.post('/connections/:id/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ sendTestMessage: z.boolean().default(false) }), req.body ?? {});
    return svc.testConnection(ctx, id, body);
  });

  app.post('/connections/:id/disconnect', async (req) => svc.disconnect(ctx, parse(idParam, req.params).id, req.user!.id));

  app.post('/connections/:id/sync', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ sinceHours: z.number().int().min(1).max(24 * 30).default(72) }), req.body ?? {});
    return syncMissedEvents(ctx, id, body.sinceHours);
  });

  app.get('/connections/:id/templates', async (req) => svc.listTemplates(ctx, parse(idParam, req.params).id));

  /** Health check interne fournisseur (léger) */
  app.get('/connections/:id/health', async (req) => {
    const { id } = parse(idParam, req.params);
    const conn = await one(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [id]);
    if (!conn) throw notFound('Connexion');
    if (!conn.api_key_enc) return { ok: false, detail: 'Aucune clé API' };
    const started = Date.now();
    const r = await ctx.connectorFor(conn).testAuth();
    return { ok: r.ok, latencyMs: Date.now() - started, detail: r.ok ? 'API joignable, clé valide' : r.error.message };
  });

  app.post('/connections/:id/activate', async (req) => {
    const { id } = parse(idParam, req.params);
    const conn = await one(ctx.db, 'SELECT * FROM provider_connections WHERE id=$1', [id]);
    if (!conn) throw notFound('Connexion');
    if (!conn.phone_number) throw badRequest('Sélectionnez d’abord un numéro');
    await ctx.db.query('UPDATE app_settings SET active_connection_id=$1 WHERE id=1', [id]);
    return svc.listConnections(ctx);
  });
}
