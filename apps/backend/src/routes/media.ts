import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { one } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { sendDirectTest } from '../services/connections.js';
import * as media from '../services/media.js';
import { getActiveConnection } from '../services/runs.js';

const idParam = z.object({ id: z.string().uuid() });

export async function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/media', async (req) => media.listMedia(ctx, parse(z.object({ kind: z.enum(['audio', 'image']).optional() }), req.query).kind));

  app.get('/media/capabilities', async () => ({
    uploadAvailable: ctx.storage.configured,
    storage: ctx.storage.description,
    ffmpegAvailable: ctx.ffmpegAvailable,
  }));

  app.post('/media/upload', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Fichier manquant');
    const kindField = file.fields.kind as { value?: string } | undefined;
    const kind = parse(z.enum(['audio', 'image']), kindField?.value);
    const body = await file.toBuffer();
    return media.publicMedia(await media.uploadMedia(ctx, { kind, filename: file.filename, mime: file.mimetype, body, userId: req.user!.id }));
  });

  app.post('/media/url', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ kind: z.enum(['audio', 'image']), url: z.string().url(), name: z.string().max(200).optional() }), req.body);
    return media.publicMedia(await media.addMediaFromUrl(ctx, { ...body, userId: req.user!.id }));
  });

  app.get('/media/:id/url', async (req) => ({ url: await media.getMediaUrl(ctx, parse(idParam, req.params).id) }));

  app.delete('/media/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { force } = parse(z.object({ force: z.coerce.boolean().optional() }), req.query);
    return media.deleteMedia(ctx, id, req.user!.id, !!force);
  });

  app.post('/media/:id/replace', async (req) => {
    const { id } = parse(idParam, req.params);
    const { newMediaId } = parse(z.object({ newMediaId: z.string().uuid() }), req.body);
    return media.replaceMedia(ctx, id, newMediaId, req.user!.id);
  });

  app.post('/media/:id/convert', async (req) => media.publicMedia(await media.convertToOggOpus(ctx, parse(idParam, req.params).id, req.user!.id)));

  /** Tester : envoie ce média seul au numéro de test. */
  app.post('/media/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const m = await one(ctx.db, 'SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!m) throw notFound('Média');
    const s = await one(ctx.db, 'SELECT test_phone_e164 FROM app_settings WHERE id=1');
    if (!s?.test_phone_e164) throw badRequest('Définissez un numéro de test dans Réglages');
    const conn = await getActiveConnection(ctx);
    const r = await sendDirectTest(ctx, conn, s.test_phone_e164, { kind: m.kind, mediaId: id });
    const caps = ctx.connectorFor(conn).capabilities();
    return {
      ...r,
      to: s.test_phone_e164,
      note:
        m.kind === 'audio'
          ? caps.sendVoiceNote.status === 'SUPPORTED'
            ? 'Message vocal'
            : 'Envoyé en « Audio standard » (le fournisseur ne propose pas de message vocal/PTT). Vérifiez l’affichage sur votre téléphone.'
          : 'Image envoyée',
    };
  });
}
