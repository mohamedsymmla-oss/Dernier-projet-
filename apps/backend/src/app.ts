import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { authGuard } from './auth.js';
import type { AppContext } from './context.js';
import { AppError } from './lib/errors.js';
import { authPrivateRoutes, authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automations.js';
import { connectionRoutes } from './routes/connections.js';
import { contactRoutes } from './routes/contacts.js';
import { mediaRoutes } from './routes/media.js';
import { miscRoutes } from './routes/misc.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: ctx.config.CORS_ORIGINS ? ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()) : true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    ...(ctx.redis ? { redis: ctx.redis, nameSpace: 'rl-http:' } : {}),
  });
  await app.register(multipart, { limits: { fileSize: 17 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled_error');
    return reply.code(status).send({
      error: status === 429 ? 'RATE_LIMITED' : 'ERROR',
      message: status === 429 ? 'Trop de requêtes, réessayez dans un instant' : status >= 500 ? 'Erreur interne du serveur' : err.message,
    });
  });

  /** GET /health : backend, base de données, Redis. */
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const res: Record<string, { ok: boolean; detail?: string }> = { backend: { ok: true } };
    try {
      await ctx.db.query('SELECT 1');
      res.database = { ok: true };
    } catch (e) {
      res.database = { ok: false, detail: (e as Error).message };
    }
    if (ctx.redis) {
      try {
        res.redis = { ok: (await ctx.redis.ping()) === 'PONG' };
      } catch (e) {
        res.redis = { ok: false, detail: (e as Error).message };
      }
    } else res.redis = { ok: false, detail: 'Non configuré' };
    const ok = Object.values(res).every((r) => r.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', ...res, time: new Date().toISOString() });
  });

  await app.register(async (pub) => {
    await webhookRoutes(pub, ctx);
  });
  await app.register(async (pub) => {
    await authRoutes(pub, ctx);
  });
  await app.register(async (priv) => {
    priv.addHook('preHandler', authGuard(ctx));
    await authPrivateRoutes(priv, ctx);
    await connectionRoutes(priv, ctx);
    await contactRoutes(priv, ctx);
    await automationRoutes(priv, ctx);
    await mediaRoutes(priv, ctx);
    await miscRoutes(priv, ctx);
  });
  return app;
}
