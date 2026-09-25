import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one } from './db/pool.js';
import type { AppContext } from './context.js';
import { AppError } from './lib/errors.js';
import { audit } from './services/audit.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function createUser(ctx: AppContext, email: string, password: string, name?: string) {
  if (password.length < 10) throw new Error('Mot de passe : 10 caractères minimum');
  return one(
    ctx.db,
    `INSERT INTO users (email, password_hash, name) VALUES (lower($1), $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id, email`,
    [email, await hashPassword(password), name ?? null],
  );
}

/** Crée le compte administrateur au premier démarrage si ADMIN_EMAIL / ADMIN_PASSWORD sont définis et qu'aucun compte n'existe. */
export async function bootstrapAdmin(ctx: AppContext) {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = ctx.config;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const exists = await one(ctx.db, 'SELECT 1 FROM users LIMIT 1');
  if (exists) return;
  await createUser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD, 'Administrateur');
  ctx.log.info({ email: ADMIN_EMAIL }, 'admin_bootstrapped');
}

export async function login(ctx: AppContext, email: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const user = await one(ctx.db, 'SELECT * FROM users WHERE email=lower($1)', [email]);
  // Comparaison même si l'utilisateur n'existe pas (temps constant approximatif)
  const ok = await bcrypt.compare(password, user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
  if (!user || !ok) {
    await audit(ctx.db, 'auth.login_failed', { details: { email, ip: meta.ip } });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect');
  }
  const days = ctx.config.SESSION_DAYS;
  const session = await one(
    ctx.db,
    `INSERT INTO user_sessions (user_id, expires_at, ip, user_agent) VALUES ($1, now() + ($2 || ' days')::interval, $3, $4) RETURNING id, expires_at`,
    [user.id, String(days), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
  );
  await ctx.db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  await audit(ctx.db, 'auth.login', { userId: user.id, details: { ip: meta.ip } });
  const token = jwt.sign({ sub: user.id, sid: session!.id }, ctx.config.JWT_SECRET, { expiresIn: `${days}d`, algorithm: 'HS256' });
  return { token, expiresAt: session!.expires_at, user: { id: user.id, email: user.email, name: user.name } };
}

export function authGuard(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'Authentification requise');
    let payload: { sub: string; sid: string };
    try {
      payload = jwt.verify(header.slice(7), ctx.config.JWT_SECRET, { algorithms: ['HS256'] }) as typeof payload;
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Session expirée : reconnectez-vous');
    }
    const row = await one(
      ctx.db,
      `SELECT u.id, u.email, u.name, s.id AS sid FROM user_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [payload.sid, payload.sub],
    );
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Session révoquée ou expirée');
    req.user = { id: row.id, email: row.email, name: row.name, sessionId: row.sid };
  };
}

export async function logout(ctx: AppContext, sessionId: string) {
  await ctx.db.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1', [sessionId]);
}
