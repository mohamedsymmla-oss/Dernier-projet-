import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ingestWebhook } from '../services/webhooks.js';

/** Endpoint public du fournisseur. Corps brut conservé pour vérifier la signature HMAC. */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post(
    '/webhooks/:provider/:connectionId',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = z.object({ provider: z.enum(['sendzen']), connectionId: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ ok: false });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
      const res = await ingestWebhook(ctx, params.data.connectionId, raw, req.headers);
      if (res.status === 'rejected') return reply.code(res.httpStatus).send({ ok: false, error: res.reason });
      return reply.code(200).send({ ok: true, duplicate: res.duplicate });
    },
  );

  /** Accessibilité publique de l'URL (utilisé par « Tester la connexion »). */
  app.get('/webhooks/:provider/:connectionId', async () => ({ ok: true, message: 'Endpoint webhook joignable (utilisez POST)' }));
}
