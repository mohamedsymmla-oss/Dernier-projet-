import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, logout } from '../auth.js';
import type { AppContext } from '../context.js';
import { parse } from '../lib/validate.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (req) => {
      const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
      return login(ctx, body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    },
  );
}

export async function authPrivateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/auth/me', async (req) => ({ user: req.user }));
  app.post('/auth/logout', async (req) => {
    await logout(ctx, req.user!.sessionId);
    return { ok: true };
  });
}
