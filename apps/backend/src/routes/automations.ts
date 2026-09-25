import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import * as cfg from '../services/automation-config.js';
import { listRecipients } from '../services/history.js';
import { publicMedia } from '../services/media.js';
import { applyPreset, deletePreset, listPresets, presetPayloadSchema, savePreset } from '../services/presets.js';
import * as runs from '../services/runs.js';

const typeParam = z.object({ type: z.enum(['A1', 'A2']) });
const runParam = z.object({ id: z.string().uuid() });

async function configView(ctx: AppContext, type: 'A1' | 'A2') {
  const c = await cfg.getConfig(ctx.db, type);
  const ids = [c.audio_media_id, ...c.photo_media_ids].filter(Boolean);
  const media = new Map((await many(ctx.db, 'SELECT * FROM media_assets WHERE id = ANY($1::uuid[])', [ids])).map((m) => [m.id, publicMedia(m)]));
  const active = await one(
    ctx.db,
    `SELECT id FROM automation_runs WHERE automation_type=$1 AND kind='SEQUENCE' AND status IN ('RUNNING','PAUSED') LIMIT 1`,
    [type],
  );
  const base = {
    automationType: type,
    audio: c.audio_media_id ? media.get(c.audio_media_id) ?? null : null,
    windowPolicy: c.window_policy,
    contentVersion: c.content_version,
    updatedAt: c.updated_at,
    activeRunId: active?.id ?? null,
  };
  if (type === 'A1') return { ...base, text1: c.text1, text2: c.text2 };
  return {
    ...base,
    photos: c.photo_media_ids.map((id) => media.get(id) ?? { id, missing: true }),
    photoCount: c.photo_count,
    delaySeconds: c.delay_between_contacts_seconds,
  };
}

export async function automationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/automations/:type/config', async (req) => configView(ctx, parse(typeParam, req.params).type));

  // ---- Réglages : un endpoint par champ (isolation garantie) ----
  app.put('/automations/:type/audio', async (req) => {
    const { type } = parse(typeParam, req.params);
    const { mediaId } = parse(z.object({ mediaId: z.string().uuid().nullable() }), req.body);
    await cfg.setAudio(ctx.db, type, mediaId);
    await audit(ctx.db, 'config.audio', { userId: req.user!.id, entityType: 'automation_config', entityId: type, details: { mediaId } });
    return configView(ctx, type);
  });
  app.put('/automations/A1/texts/:which', async (req) => {
    const { which } = parse(z.object({ which: z.enum(['text1', 'text2']) }), req.params);
    const { value } = parse(z.object({ value: z.string().max(4096) }), req.body);
    await cfg.setText(ctx.db, which, value);
    await audit(ctx.db, `config.${which}`, { userId: req.user!.id, entityType: 'automation_config', entityId: 'A1' });
    return configView(ctx, 'A1');
  });
  app.put('/automations/A2/photos', async (req) => {
    const { mediaIds } = parse(z.object({ mediaIds: z.array(z.string().uuid()).max(10) }), req.body);
    await cfg.setPhotos(ctx.db, mediaIds);
    await audit(ctx.db, 'config.photos', { userId: req.user!.id, entityType: 'automation_config', entityId: 'A2', details: { count: mediaIds.length } });
    return configView(ctx, 'A2');
  });
  app.put('/automations/A2/photo-count', async (req) => {
    const { count } = parse(z.object({ count: z.number().int().min(1).max(10) }), req.body);
    await cfg.setPhotoCount(ctx.db, count);
    await audit(ctx.db, 'config.photo_count', { userId: req.user!.id, entityType: 'automation_config', entityId: 'A2', details: { count } });
    return configView(ctx, 'A2');
  });
  app.put('/automations/A2/delay', async (req) => {
    const { seconds } = parse(z.object({ seconds: z.number().int().min(1).max(120) }), req.body);
    await cfg.setDelay(ctx.db, seconds);
    await audit(ctx.db, 'config.delay', { userId: req.user!.id, entityType: 'automation_config', entityId: 'A2', details: { seconds } });
    // Si une campagne attend, on la reprogramme pour appliquer immédiatement le nouveau délai.
    const run = await one(ctx.db, `SELECT * FROM automation_runs WHERE automation_type='A2' AND kind='SEQUENCE' AND status='RUNNING'`);
    if (run) await runs.dispatchRun(ctx, run);
    return configView(ctx, 'A2');
  });
  app.put('/automations/:type/window-policy', async (req) => {
    const { type } = parse(typeParam, req.params);
    const { policy } = parse(z.object({ policy: z.enum(['ALLOW_UNKNOWN', 'REQUIRE_KNOWN']) }), req.body);
    await cfg.setWindowPolicy(ctx.db, type, policy);
    return configView(ctx, type);
  });

  // ---- Vérification avant démarrage ----
  app.get('/automations/:type/readiness', async (req) => {
    const { type } = parse(typeParam, req.params);
    const problems: Array<{ field: string; message: string }> = [];
    let connection = null;
    try {
      connection = await runs.getActiveConnection(ctx);
    } catch (e) {
      problems.push({ field: 'connection', message: (e as Error).message });
    }
    try {
      await cfg.buildSnapshot(ctx.db, type);
    } catch (e) {
      const details = (e as { details?: Array<{ field: string; message: string }> }).details;
      problems.push(...(details ?? [{ field: 'config', message: (e as Error).message }]));
    }
    return {
      ready: problems.length === 0,
      problems,
      connection: connection ? { provider: connection.provider, phoneNumber: connection.phone_number, mode: connection.mode, label: connection.label } : null,
    };
  });

  // ---- Campagnes ----
  app.post('/runs', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({
        automationType: z.enum(['A1', 'A2']),
        importId: z.string().uuid(),
        clientRequestId: z.string().min(8).max(100),
        confirm: z.literal(true),
      }),
      req.body,
    );
    const r = await runs.createRun(ctx, {
      type: body.automationType,
      kind: 'SEQUENCE',
      importId: body.importId,
      clientRequestId: body.clientRequestId,
      userId: req.user!.id,
    });
    reply.code(r.created ? 201 : 200);
    return { run: runs.publicRun(r.run), created: r.created };
  });

  app.post('/automations/:type/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { type } = parse(typeParam, req.params);
    const { clientRequestId } = parse(z.object({ clientRequestId: z.string().min(8) }), req.body);
    const r = await runs.startTestRun(ctx, type, clientRequestId, req.user!.id);
    return { run: runs.publicRun(r.run) };
  });

  app.post('/automations/:type/template-followup', async (req) => {
    const { type } = parse(typeParam, req.params);
    const body = parse(
      z.object({ templateName: z.string().min(1), language: z.string().min(2), clientRequestId: z.string().min(8), confirm: z.literal(true) }),
      req.body,
    );
    const conn = await runs.getActiveConnection(ctx);
    const contacts = await many(
      ctx.db,
      `SELECT r.contact_id FROM automation_recipients r JOIN automation_runs run ON run.id=r.run_id
        WHERE r.automation_type=$1 AND r.status='TEMPLATE_REQUIRED' AND run.kind='SEQUENCE' AND run.mode=$2`,
      [type, conn.mode],
    );
    const r = await runs.createRun(ctx, {
      type,
      kind: 'TEMPLATE',
      clientRequestId: body.clientRequestId,
      contactIds: contacts.map((c) => c.contact_id),
      template: { name: body.templateName, language: body.language },
      userId: req.user!.id,
    });
    return { run: runs.publicRun(r.run), created: r.created };
  });

  app.get('/runs', async (req) => {
    const q = parse(z.object({ type: z.enum(['A1', 'A2']).optional(), includeTests: z.coerce.boolean().optional() }), req.query);
    const rows = await many(
      ctx.db,
      `SELECT * FROM automation_runs WHERE ($1::text IS NULL OR automation_type=$1) AND ($2 OR kind <> 'TEST')
        ORDER BY created_at DESC LIMIT 100`,
      [q.type ?? null, !!q.includeTests],
    );
    return rows.map(runs.publicRun);
  });
  app.get('/runs/active', async (req) => {
    const { type } = parse(z.object({ type: z.enum(['A1', 'A2']) }), req.query);
    const run = await one(
      ctx.db,
      `SELECT id FROM automation_runs WHERE automation_type=$1 AND kind='SEQUENCE' ORDER BY (status IN ('RUNNING','PAUSED')) DESC, created_at DESC LIMIT 1`,
      [type],
    );
    return run ? runs.getRunProgress(ctx, run.id) : null;
  });
  app.get('/runs/:id', async (req) => runs.getRunProgress(ctx, parse(runParam, req.params).id));
  app.get('/runs/:id/recipients', async (req) => {
    const { id } = parse(runParam, req.params);
    const q = parse(z.object({ status: z.string().optional(), page: z.coerce.number().optional() }), req.query);
    return listRecipients(ctx, { runId: id, status: q.status, page: q.page, includeTests: true });
  });
  app.post('/runs/:id/pause', async (req) => runs.publicRun(await runs.pauseRun(ctx, parse(runParam, req.params).id, req.user!.id)));
  app.post('/runs/:id/resume', async (req) => runs.publicRun(await runs.resumeRun(ctx, parse(runParam, req.params).id, req.user!.id)));
  app.post('/runs/:id/stop', async (req) => runs.publicRun(await runs.stopRun(ctx, parse(runParam, req.params).id, req.user!.id)));
  app.post('/runs/:id/retry', async (req) => {
    const { id } = parse(runParam, req.params);
    const body = parse(z.object({ includeUncertain: z.boolean().default(false) }), req.body ?? {});
    return runs.retryRecipients(ctx, { runId: id, includeUncertain: body.includeUncertain, userId: req.user!.id });
  });
  app.post('/recipients/:id/retry', async (req) => {
    const { id } = parse(runParam, req.params);
    const body = parse(z.object({ includeUncertain: z.boolean().default(false) }), req.body ?? {});
    return runs.retryRecipients(ctx, { recipientId: id, includeUncertain: body.includeUncertain, userId: req.user!.id });
  });

  // ---- Présets ----
  app.get('/presets', async (req) => listPresets(ctx, parse(z.object({ type: z.enum(['A1', 'A2']).optional() }), req.query).type));
  app.post('/presets', async (req) => {
    const body = parse(z.object({ automationType: z.enum(['A1', 'A2']), name: z.string().min(1).max(80), payload: presetPayloadSchema }), req.body);
    return savePreset(ctx, body.automationType, body.name, body.payload, req.user!.id);
  });
  app.post('/presets/:id/apply', async (req) => {
    const { id } = parse(runParam, req.params);
    const c = await applyPreset(ctx, id, req.user!.id);
    return configView(ctx, c.automation_type);
  });
  app.delete('/presets/:id', async (req) => {
    const { id } = parse(runParam, req.params);
    const p = await one(ctx.db, 'SELECT id FROM saved_presets WHERE id=$1', [id]);
    if (!p) throw notFound('Préset');
    await deletePreset(ctx, id);
    return { deleted: true };
  });
}
