import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many } from '../db/pool.js';
import { parse } from '../lib/validate.js';
import { contactTimeline, listContacts } from '../services/history.js';
import { analyzeImport, createImport, createRespondersImport } from '../services/imports.js';

export async function contactRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/imports', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const body = parse(
      z.object({
        automationType: z.enum(['A1', 'A2']).nullable().default(null),
        source: z.enum(['paste', 'csv', 'txt']),
        content: z.string().min(1),
        filename: z.string().max(200).optional().nullable(),
        defaultCountry: z.string().length(2).optional().nullable(),
      }),
      req.body,
    );
    return createImport(ctx, { ...body, userId: req.user!.id });
  });

  app.post('/imports/responders', async (req) => createRespondersImport(ctx, req.user!.id));

  app.get('/imports/:id/analysis', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { type } = parse(z.object({ type: z.enum(['A1', 'A2']).optional() }), req.query);
    return analyzeImport(ctx, id, type ?? null);
  });

  app.get('/imports/:id/items', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { status } = parse(z.object({ status: z.string().optional() }), req.query);
    return many(
      ctx.db,
      `SELECT line_number, raw_value, status, phone_e164, reason FROM contact_import_items WHERE import_id=$1 ${status ? 'AND status=$2' : ''} ORDER BY line_number LIMIT 5000`,
      status ? [id, status] : [id],
    );
  });

  app.get('/contacts', async (req) => {
    const q = parse(
      z.object({ q: z.string().optional(), filter: z.string().optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }),
      req.query,
    );
    return listContacts(ctx, q);
  });

  app.get('/contacts/:id/timeline', async (req) => contactTimeline(ctx, parse(z.object({ id: z.string().uuid() }), req.params).id));
}
