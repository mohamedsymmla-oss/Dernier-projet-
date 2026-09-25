import type { FastifyInstance } from 'fastify';
import { normalizePhone } from '@wa/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { dashboard, listRecipients } from '../services/history.js';

export async function miscRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/dashboard', async () => dashboard(ctx));

  app.get('/settings', async () => {
    const s = await one(ctx.db, 'SELECT * FROM app_settings WHERE id=1');
    return {
      testPhone: s.test_phone_e164,
      defaultCountry: s.default_country,
      activeConnectionId: s.active_connection_id,
      server: {
        storage: ctx.storage.description,
        uploadAvailable: ctx.storage.configured,
        ffmpegAvailable: ctx.ffmpegAvailable,
        publicBackendUrl: ctx.config.PUBLIC_BACKEND_URL ?? null,
        a1Concurrency: ctx.config.A1_CONCURRENCY,
        maxMessagesPerSecond: ctx.config.PROVIDER_MAX_MESSAGES_PER_SECOND,
        maxAttempts: ctx.config.SEND_MAX_ATTEMPTS,
      },
    };
  });
  app.put('/settings/test-phone', async (req) => {
    const { phone } = parse(z.object({ phone: z.string().nullable() }), req.body);
    let e164: string | null = null;
    if (phone) {
      const s = await one(ctx.db, 'SELECT default_country FROM app_settings WHERE id=1');
      const n = normalizePhone(phone, s.default_country);
      if (!n.ok) throw badRequest(`Numéro invalide : ${n.label}`);
      e164 = n.e164;
    }
    await ctx.db.query('UPDATE app_settings SET test_phone_e164=$1, updated_at=now() WHERE id=1', [e164]);
    await audit(ctx.db, 'settings.test_phone', { userId: req.user!.id });
    return { testPhone: e164 };
  });
  app.put('/settings/default-country', async (req) => {
    const { country } = parse(z.object({ country: z.string().length(2) }), req.body);
    await ctx.db.query('UPDATE app_settings SET default_country=upper($1), updated_at=now() WHERE id=1', [country]);
    return { defaultCountry: country.toUpperCase() };
  });

  app.get('/history', async (req) => {
    const q = parse(
      z.object({
        automation: z.enum(['A1', 'A2']).optional(),
        status: z.string().optional(),
        result: z.enum(['success', 'failure']).optional(),
        q: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        provider: z.string().optional(),
        mode: z.enum(['PRODUCTION', 'TEST']).optional(),
        includeTests: z.coerce.boolean().optional(),
        page: z.coerce.number().optional(),
        pageSize: z.coerce.number().optional(),
      }),
      req.query,
    );
    return listRecipients(ctx, q);
  });

  // ---- Journal technique (aucun secret n'y est jamais écrit) ----
  app.get('/logs/provider', async (req) => {
    const q = parse(
      z.object({ errorsOnly: z.coerce.boolean().optional(), q: z.string().optional(), page: z.coerce.number().default(1) }),
      req.query,
    );
    const where: string[] = [];
    const p: unknown[] = [];
    if (q.errorsOnly) where.push('(error IS NOT NULL OR http_status >= 400)');
    if (q.q) {
      p.push(q.q);
      where.push(`(provider_message_id = $${p.length} OR request_id = $${p.length} OR endpoint LIKE '%' || $${p.length} || '%' OR run_id::text = $${p.length})`);
    }
    return many(
      ctx.db,
      `SELECT id, provider, method, endpoint, http_status, request_id, provider_message_id, error, attempt, duration_ms,
              run_id, recipient_id, response_snippet, created_at
         FROM provider_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT 100 OFFSET ${(q.page - 1) * 100}`,
      p,
    );
  });
  app.get('/logs/webhooks', async (req) => {
    const q = parse(z.object({ page: z.coerce.number().default(1) }), req.query);
    return many(
      ctx.db,
      `SELECT id, connection_id, provider, source, signature_verified, verification_note, duplicate_count, received_at,
              process_status, processed_at, process_error, event_count, payload
         FROM webhook_events ORDER BY received_at DESC LIMIT 50 OFFSET ${(q.page - 1) * 50}`,
    );
  });
  app.get('/logs/audit', async () =>
    many(ctx.db, `SELECT a.*, u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200`),
  );
  app.get('/logs/sync', async () => many(ctx.db, `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 50`));
}
