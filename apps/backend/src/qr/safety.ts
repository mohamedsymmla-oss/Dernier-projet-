import { one } from '../db/pool.js';
import type { AppContext, QrGateDecision } from '../context.js';
import { getSession, logQrEvent, pauseQrRuns } from './store.js';

export interface QrSettings {
  daily_message_cap: number;
  quiet_hours_enabled: boolean;
  quiet_start: string; // HH:MM:SS
  quiet_end: string;
  timezone: string;
  warmup_days: number;
  typing_simulation: boolean;
  emergency_stopped: boolean;
  emergency_reason: string | null;
  emergency_at: Date | null;
}

export async function getQrSettings(ctx: Pick<AppContext, 'db'>): Promise<QrSettings> {
  return (await one<QrSettings>(ctx.db, 'SELECT * FROM qr_settings WHERE id=1'))!;
}

/** Minutes écoulées depuis minuit dans le fuseau donné. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Si l'heure est dans la plage calme, renvoie le délai (ms) jusqu'à la fin de la plage ; sinon null. */
export function quietHoursWait(now: Date, s: Pick<QrSettings, 'quiet_hours_enabled' | 'quiet_start' | 'quiet_end' | 'timezone'>): number | null {
  if (!s.quiet_hours_enabled) return null;
  const cur = localMinutes(now, s.timezone);
  const start = toMinutes(s.quiet_start);
  const end = toMinutes(s.quiet_end);
  if (start === end) return null;
  const inQuiet = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!inQuiet) return null;
  const minutes = (end - cur + 1440) % 1440 || 1440;
  return minutes * 60_000 - now.getUTCSeconds() * 1000;
}

/** Délai jusqu'au prochain minuit local (réinitialisation du plafond quotidien). */
export function msUntilLocalMidnight(now: Date, timezone: string): number {
  const cur = localMinutes(now, timezone);
  return (1440 - cur) * 60_000 - now.getUTCSeconds() * 1000;
}

/** Début de la journée locale, en UTC (pour compter les messages du jour). */
export function localDayStart(now: Date, timezone: string): Date {
  return new Date(now.getTime() - localMinutes(now, timezone) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds());
}

/** Plafond effectif : réduit de moitié pendant la montée progressive d'une nouvelle session. */
export function effectiveDailyCap(s: QrSettings, pairedAt: Date | null, now: Date): { cap: number; warmup: boolean } {
  const warmup = !!pairedAt && s.warmup_days > 0 && now.getTime() - new Date(pairedAt).getTime() < s.warmup_days * 86_400_000;
  return { cap: warmup ? Math.max(1, Math.floor(s.daily_message_cap / 2)) : s.daily_message_cap, warmup };
}

export async function messagesSentToday(ctx: Pick<AppContext, 'db'>, now: Date, timezone: string): Promise<number> {
  const r = await one(
    ctx.db,
    `SELECT count(*)::int AS n FROM outbound_messages o JOIN provider_connections c ON c.id=o.connection_id
      WHERE c.provider='qr' AND o.submitted_at >= $1 AND o.status <> 'FAILED'`,
    [localDayStart(now, timezone)],
  );
  return r?.n ?? 0;
}

/**
 * Garde-fous appliqués avant chaque contact d'une campagne QR. Priorité à la protection du numéro :
 * arrêt d'urgence → session → heures calmes → plafond du jour (y compris la séquence entière du contact).
 */
export async function qrGate(ctx: AppContext, run: { config_snapshot?: { steps?: unknown[] } }): Promise<QrGateDecision> {
  const s = await getQrSettings(ctx);
  if (s.emergency_stopped) return { action: 'pause', reason: `Arrêt d'urgence WhatsApp QR : ${s.emergency_reason ?? 'signal de restriction'}` };
  const session = await getSession(ctx.db);
  if (!session || session.status !== 'CONNECTED') {
    if (session?.desired_state === 'RUNNING' && (session.status === 'CONNECTING' || session.status === 'DISCONNECTED')) {
      return { action: 'wait', waitMs: 30_000, reason: 'WhatsApp QR en reconnexion : reprise automatique' };
    }
    return { action: 'pause', reason: 'WhatsApp QR déconnecté : reconnectez-le (scan du QR) puis reprenez' };
  }
  const now = ctx.clock.now();
  const quiet = quietHoursWait(now, s);
  if (quiet !== null) {
    return { action: 'wait', waitMs: quiet, reason: `Heures calmes (${s.quiet_start.slice(0, 5)}–${s.quiet_end.slice(0, 5)}) : reprise automatique` };
  }
  const { cap, warmup } = effectiveDailyCap(s, session.paired_at, now);
  const sent = await messagesSentToday(ctx, now, s.timezone);
  const needed = Math.max(1, run.config_snapshot?.steps?.length ?? 1);
  if (sent + needed > cap) {
    return {
      action: 'wait',
      waitMs: msUntilLocalMidnight(now, s.timezone) + 5 * 60_000,
      reason: `Plafond du jour atteint (${sent}/${cap} messages${warmup ? ', montée progressive' : ''}) : reprise demain`,
    };
  }
  return { action: 'go' };
}

/** Déclenche l'arrêt d'urgence : tous les envois QR sont suspendus jusqu'à réactivation manuelle. */
export async function triggerEmergencyStop(ctx: Pick<AppContext, 'db' | 'log'>, reason: string) {
  const r = await ctx.db.query(
    `UPDATE qr_settings SET emergency_stopped=true, emergency_reason=$1, emergency_at=now(), updated_at=now()
      WHERE id=1 AND NOT emergency_stopped`,
    [reason],
  );
  if (r.rowCount) {
    await pauseQrRuns(ctx.db, `Arrêt d'urgence WhatsApp QR : ${reason}`);
    const s = await getSession(ctx.db);
    await logQrEvent(ctx.db, s?.id ?? null, 'emergency_stop', { reason });
    ctx.log.error({ reason }, 'qr_emergency_stop');
  }
}
