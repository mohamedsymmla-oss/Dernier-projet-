import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { effectiveDailyCap, getQrSettings, messagesSentToday } from '../qr/safety.js';
import { getOrCreateSession, logQrEvent, updateSession } from '../qr/store.js';

export async function qrRoutes(app: FastifyInstance, ctx: AppContext) {
  /** État de la connexion QR (interrogé toutes les 2 s par l'écran pendant l'affichage du QR). */
  app.get('/qr/session', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async () => {
    const s = await getOrCreateSession(ctx.db);
    const settings = await getQrSettings(ctx);
    const now = ctx.clock.now();
    const { cap, warmup } = effectiveDailyCap(settings, s.paired_at, now);
    const provider = await one(
      ctx.db,
      `SELECT c.phone_number FROM app_settings a JOIN provider_connections c ON c.id=a.active_connection_id WHERE a.id=1`,
    );
    const events = await many(ctx.db, 'SELECT type, detail, created_at FROM qr_events ORDER BY created_at DESC LIMIT 15');
    return {
      status: s.status,
      desiredState: s.desired_state,
      qr: s.status === 'WAITING_SCAN' ? s.qr : null,
      qrUpdatedAt: s.qr_updated_at,
      phoneNumber: s.phone_number,
      pushName: s.push_name,
      pairedAt: s.paired_at,
      connectedAt: s.connected_at,
      disconnectedAt: s.disconnected_at,
      lastError: s.last_error,
      sameNumberAsProvider: !!s.phone_number && s.phone_number === provider?.phone_number,
      safety: {
        emergencyStopped: settings.emergency_stopped,
        emergencyReason: settings.emergency_reason,
        emergencyAt: settings.emergency_at,
        sentToday: await messagesSentToday(ctx, now, settings.timezone),
        dailyCap: cap,
        warmup,
      },
      events,
      serverTime: now.toISOString(),
    };
  });

  /** Démarre la connexion : le worker ouvre la session et publie le QR. */
  app.post('/qr/session/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!ctx.qrControl) throw badRequest('Canal QR indisponible sur ce serveur');
    const s = await getOrCreateSession(ctx.db);
    if (s.status === 'CONNECTED') return { status: s.status };
    await updateSession(ctx.db, s.id, { desired_state: 'RUNNING', status: 'CONNECTING', last_error: null } as never);
    await logQrEvent(ctx.db, s.id, 'start_requested');
    await audit(ctx.db, 'qr.start', { userId: req.user!.id, entityType: 'qr_session', entityId: s.id });
    await ctx.qrControl('start');
    return { status: 'CONNECTING' };
  });

  /** Déconnexion + suppression de la session (un nouveau scan sera nécessaire). */
  app.post('/qr/session/logout', async (req) => {
    if (!ctx.qrControl) throw badRequest('Canal QR indisponible sur ce serveur');
    const s = await getOrCreateSession(ctx.db);
    await updateSession(ctx.db, s.id, { desired_state: 'STOPPED' } as never);
    await audit(ctx.db, 'qr.logout', { userId: req.user!.id, entityType: 'qr_session', entityId: s.id });
    await ctx.qrControl('logout');
    return { status: 'LOGGED_OUT' };
  });

  const settingsSchema = z.object({
    dailyMessageCap: z.number().int().min(1).max(5000).optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    quietEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    timezone: z.string().min(3).max(60).optional(),
    warmupDays: z.number().int().min(0).max(60).optional(),
    typingSimulation: z.boolean().optional(),
  });

  app.get('/qr/settings', async () => publicSettings(await getQrSettings(ctx)));

  app.put('/qr/settings', async (req) => {
    const b = parse(settingsSchema, req.body);
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('fr', { timeZone: b.timezone });
      } catch {
        throw badRequest('Fuseau horaire inconnu (ex : Africa/Bamako)');
      }
    }
    const map: Record<string, unknown> = {
      daily_message_cap: b.dailyMessageCap,
      quiet_hours_enabled: b.quietHoursEnabled,
      quiet_start: b.quietStart,
      quiet_end: b.quietEnd,
      timezone: b.timezone,
      warmup_days: b.warmupDays,
      typing_simulation: b.typingSimulation,
    };
    const entries = Object.entries(map).filter(([, v]) => v !== undefined);
    if (entries.length) {
      await ctx.db.query(
        `UPDATE qr_settings SET ${entries.map(([k], i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=1`,
        entries.map(([, v]) => v),
      );
      await audit(ctx.db, 'qr.settings', { userId: req.user!.id, details: Object.fromEntries(entries) });
    }
    return publicSettings(await getQrSettings(ctx));
  });

  /** Lever l'arrêt d'urgence : action volontaire, tracée. Les campagnes restent en pause (reprise manuelle). */
  app.post('/qr/emergency/reset', async (req) => {
    await ctx.db.query('UPDATE qr_settings SET emergency_stopped=false, emergency_reason=NULL, emergency_at=NULL, updated_at=now() WHERE id=1');
    const s = await getOrCreateSession(ctx.db);
    await logQrEvent(ctx.db, s.id, 'emergency_reset');
    await audit(ctx.db, 'qr.emergency_reset', { userId: req.user!.id });
    return publicSettings(await getQrSettings(ctx));
  });

  app.get('/qr/events', async () => many(ctx.db, 'SELECT * FROM qr_events ORDER BY created_at DESC LIMIT 200'));
}

function publicSettings(s: Awaited<ReturnType<typeof getQrSettings>>) {
  return {
    dailyMessageCap: s.daily_message_cap,
    quietHoursEnabled: s.quiet_hours_enabled,
    quietStart: s.quiet_start.slice(0, 5),
    quietEnd: s.quiet_end.slice(0, 5),
    timezone: s.timezone,
    warmupDays: s.warmup_days,
    typingSimulation: s.typing_simulation,
    emergencyStopped: s.emergency_stopped,
    emergencyReason: s.emergency_reason,
    emergencyAt: s.emergency_at,
  };
}
