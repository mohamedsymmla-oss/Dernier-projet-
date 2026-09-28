import type pg from 'pg';
import type { NormalizedEvent } from '@wa/provider-connectors';
import type { AppContext } from '../context.js';
import { many } from '../db/pool.js';
import { resumeRun } from '../services/runs.js';
import { applyNormalizedEvent } from '../services/webhooks.js';
import { clearAuthState, loadAuthState } from './auth-store.js';
import type { QrSocketProvider } from './connector.js';
import { triggerEmergencyStop } from './safety.js';
import type { MakeQrSocket, QrSocket } from './socket-port.js';
import { getOrCreateSession, logQrEvent, pauseQrRuns, updateSession } from './store.js';

const LOCK_KEY = 7_421_987; // verrou PostgreSQL : un seul socket WhatsApp QR actif, toutes instances confondues
const MAX_QR_ROTATIONS = 6; // ~2 minutes de QR affichés sans scan → on arrête (pas de boucle infinie)
const DISCONNECTED_PAUSE_PREFIX = 'WhatsApp QR déconnecté';

/** Codes de fermeture Baileys (DisconnectReason). */
const CODE = { loggedOut: 401, forbidden: 403, connectionReplaced: 440, restartRequired: 515, badSession: 500 };

export function jidToE164(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0]!.split(':')[0]!.replace(/[^\d]/g, '');
  return digits.length >= 7 ? '+' + digits : null;
}

/** Messages à ignorer : groupes, statuts, diffusions, newsletters. */
export function isIgnoredJid(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

const STATUS_MAP: Record<number, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = { 0: 'FAILED', 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'READ' };

function textOf(m: any): string | null {
  const msg = m?.message ?? {};
  return msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? null;
}

function typeOf(m: any): string {
  const keys = Object.keys(m?.message ?? {}).filter((k) => k !== 'messageContextInfo');
  const k = keys[0] ?? 'unknown';
  return k.replace(/Message$/, '').replace('conversation', 'text').replace('extendedText', 'text');
}

/**
 * Gestionnaire de la session WhatsApp QR (tourne dans le worker, toujours actif).
 * - Affiche le QR (rotation ~20 s), détecte le scan, enregistre la session chiffrée en base.
 * - Reconnexion automatique avec attente croissante ; jamais de boucle sur un refus (401/403/440).
 * - Reçoit messages entrants et accusés (livré / lu) → même historique que le fournisseur, canal séparé.
 */
export class QrSessionManager implements QrSocketProvider {
  private sock: QrSocket | null = null;
  private connected = false;
  private lockClient: pg.PoolClient | null = null;
  private sessionId: string | null = null;
  private connectionId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private qrRotations = 0;
  private stopping = false;
  private watchdog: NodeJS.Timeout | null = null;
  private creds: { registered?: boolean; me?: unknown } | null = null;
  /** Les événements Baileys sont traités strictement dans l'ordre (évite qu'un ancien état écrase un nouveau). */
  private chain: Promise<void> = Promise.resolve();

  private enqueue(label: string, fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e) => this.log().error({ err: e }, label));
    return this.chain;
  }

  /** Attend la fin du traitement des événements en cours (tests, arrêt propre). */
  async idle() {
    await this.chain;
  }

  constructor(
    private readonly ctx: AppContext,
    private readonly makeSocket: MakeQrSocket,
    private readonly opts: { reconnectBaseMs?: number; reconnectMaxMs?: number; connectWatchdogMs?: number } = {},
  ) {}

  connectedSocket(): QrSocket | null {
    return this.connected ? this.sock : null;
  }

  isRunning() {
    return !!this.sock;
  }

  private log() {
    return this.ctx.log.child({ component: 'qr-session', session_id: this.sessionId });
  }

  private async acquireLock(): Promise<boolean> {
    if (this.lockClient) return true;
    const client = await this.ctx.db.connect();
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!r.rows[0].ok) {
      client.release();
      return false;
    }
    this.lockClient = client;
    return true;
  }

  private async releaseLock() {
    if (!this.lockClient) return;
    await this.lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    this.lockClient.release();
    this.lockClient = null;
  }

  /** Démarre (ou redémarre) le socket si la session doit tourner. */
  async start(): Promise<void> {
    if (this.sock) return;
    const session = await getOrCreateSession(this.ctx.db);
    this.sessionId = session.id;
    this.connectionId = session.connection_id;
    if (!(await this.acquireLock())) {
      this.log().warn('qr_lock_busy');
      return;
    }
    this.stopping = false;
    this.qrRotations = 0;
    await updateSession(this.ctx.db, session.id, { status: 'CONNECTING', last_error: null } as never);
    const { state, saveCreds } = await loadAuthState(this.ctx.db, this.ctx.secrets, session.id);
    this.creds = state.creds as never;
    const sock = this.makeSocket({ auth: state, logger: this.ctx.log.child({ component: 'baileys' }) });
    this.sock = sock;

    sock.ev.on('creds.update', () => void this.enqueue('qr_creds_save_failed', () => saveCreds()));
    sock.ev.on('connection.update', (u) => void this.enqueue('qr_conn_update_failed', () => this.onConnectionUpdate(sock, u)));
    sock.ev.on('messages.upsert', (u) => void this.enqueue('qr_upsert_failed', () => this.onMessages(u)));
    sock.ev.on('messages.update', (u) => void this.enqueue('qr_update_failed', () => this.onUpdates(u)));

    // Chien de garde : si WhatsApp ne répond pas (ni QR ni connexion), on n'attend pas indéfiniment.
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      void this.enqueue('qr_watchdog_failed', () =>
        this.onConnectionUpdate(sock, {
          connection: 'close',
          lastDisconnect: { error: { message: 'Délai de connexion dépassé : WhatsApp injoignable', output: { statusCode: 408 } } },
        }),
      );
    }, this.opts.connectWatchdogMs ?? 60_000);
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private async onConnectionUpdate(sock: QrSocket, u: any) {
    if (sock !== this.sock || !this.sessionId) return;
    const id = this.sessionId;
    if (u.qr) {
      this.clearWatchdog();
      this.qrRotations++;
      if (this.qrRotations > MAX_QR_ROTATIONS) {
        await this.shutdown('QR expiré : relancez la connexion pour obtenir un nouveau QR', 'DISCONNECTED', true);
        return;
      }
      await updateSession(this.ctx.db, id, { status: 'WAITING_SCAN', qr: u.qr, qr_updated_at: this.ctx.clock.now() } as never);
      if (this.qrRotations === 1) await logQrEvent(this.ctx.db, id, 'qr_displayed');
    }
    if (u.connection === 'open') {
      this.clearWatchdog();
      this.connected = true;
      this.reconnectAttempts = 0;
      const phone = jidToE164(sock.user?.id ?? null);
      const now = this.ctx.clock.now();
      await this.ctx.db.query('UPDATE qr_sessions SET paired_at = coalesce(paired_at, $2) WHERE id=$1', [id, now]);
      await updateSession(this.ctx.db, id, {
        status: 'CONNECTED', qr: null, phone_number: phone, push_name: sock.user?.name ?? null,
        connected_at: now, last_error: null, last_disconnect_code: null,
      } as never);
      await logQrEvent(this.ctx.db, id, 'connected', { phone });
      this.log().info({ phone }, 'qr_connected');
      await this.resumeRunsPausedByDisconnection();
    }
    if (u.connection === 'close') {
      this.clearWatchdog();
      this.connected = false;
      const code: number | undefined = u.lastDisconnect?.error?.output?.statusCode;
      const message = String(u.lastDisconnect?.error?.message ?? '');
      await logQrEvent(this.ctx.db, id, 'closed', { code, message: message.slice(0, 200) });
      if (this.stopping) return;
      if (code === CODE.loggedOut) {
        await clearAuthState(this.ctx.db, id);
        await this.shutdown('Session fermée depuis le téléphone (appareil délié) : scannez un nouveau QR', 'LOGGED_OUT', true);
        return;
      }
      if (code === CODE.forbidden) {
        await triggerEmergencyStop(this.ctx, 'WhatsApp a refusé la connexion (403)');
        await this.shutdown('WhatsApp a refusé la connexion (403)', 'DISCONNECTED', true);
        return;
      }
      if (code === CODE.connectionReplaced) {
        await this.shutdown('Session ouverte ailleurs (connexion remplacée) : reconnexion manuelle requise', 'DISCONNECTED', true);
        return;
      }
      // Appareil déjà lié (session enregistrée) → reconnexion automatique ; sinon on n'insiste pas.
      const registered = !!this.creds?.registered || !!this.creds?.me;
      if (!registered && code !== CODE.restartRequired) {
        const why = message.includes('injoignable') ? 'WhatsApp injoignable depuis le serveur' : 'Connexion interrompue avant le scan';
        await this.shutdown(`${why} : relancez la connexion`, 'DISCONNECTED', true);
        return;
      }
      this.scheduleReconnect(code === CODE.restartRequired ? 0 : undefined, `Connexion perdue (${code ?? 'inconnu'})`);
    }
  }

  private scheduleReconnect(forcedMs: number | undefined, reason: string) {
    const base = this.opts.reconnectBaseMs ?? 2000;
    const max = this.opts.reconnectMaxMs ?? 5 * 60_000;
    const wait = forcedMs ?? Math.min(max, base * 2 ** this.reconnectAttempts) + Math.floor(Math.random() * Math.min(1000, base));
    this.reconnectAttempts++;
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.ev.removeAllListeners?.();
      sock?.end(undefined);
    } catch {
      /* déjà fermé */
    }
    void updateSession(this.ctx.db, this.sessionId!, { status: 'CONNECTING', last_error: `${reason} : reconnexion automatique` } as never);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((e) => this.log().error({ err: e }, 'qr_reconnect_failed'));
    }, wait);
    this.log().warn({ wait_ms: wait, attempt: this.reconnectAttempts }, 'qr_reconnect_scheduled');
  }

  /** Arrêt du socket (sans déconnecter le téléphone) avec statut et alerte. */
  private async shutdown(reason: string, status: 'DISCONNECTED' | 'LOGGED_OUT', stopDesired: boolean) {
    this.clearWatchdog();
    this.stopping = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.ev.removeAllListeners?.();
      sock?.end(undefined);
    } catch {
      /* déjà fermé */
    }
    if (this.sessionId) {
      await updateSession(this.ctx.db, this.sessionId, {
        status, qr: null, last_error: reason, disconnected_at: this.ctx.clock.now(),
        ...(stopDesired ? { desired_state: 'STOPPED' } : {}),
      } as never);
      await logQrEvent(this.ctx.db, this.sessionId, status === 'LOGGED_OUT' ? 'logged_out' : 'disconnected', { reason });
    }
    await pauseQrRuns(this.ctx.db, `${DISCONNECTED_PAUSE_PREFIX} : ${reason}`);
    await this.releaseLock();
    this.log().warn({ reason, status }, 'qr_shutdown');
  }

  /** Déconnexion demandée par l'utilisateur : délie l'appareil et supprime la session en base. */
  async logout(): Promise<void> {
    const session = await getOrCreateSession(this.ctx.db);
    this.sessionId = session.id;
    this.stopping = true;
    try {
      await this.sock?.logout();
    } catch {
      /* socket déjà fermé : on nettoie quand même */
    }
    await clearAuthState(this.ctx.db, session.id);
    await this.shutdown('Déconnecté manuellement', 'LOGGED_OUT', true);
  }

  /** Arrêt du processus (déploiement) : on ferme sans délier ; la session reprendra au redémarrage. */
  async stop(): Promise<void> {
    this.clearWatchdog();
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.connected = false;
    await this.releaseLock();
  }

  private async resumeRunsPausedByDisconnection() {
    const runs = await many(
      this.ctx.db,
      `SELECT id FROM automation_runs WHERE channel='QR' AND status='PAUSED' AND pause_reason LIKE $1`,
      [`${DISCONNECTED_PAUSE_PREFIX}%`],
    );
    for (const r of runs) await resumeRun(this.ctx, r.id).catch((e) => this.log().warn({ err: e, run_id: r.id }, 'qr_resume_failed'));
  }

  private async onMessages(u: { messages?: any[]; type?: string }) {
    if (u.type !== 'notify') return;
    for (const m of u.messages ?? []) {
      const jid: string | undefined = m?.key?.remoteJid;
      if (!m?.message || m.key?.fromMe || isIgnoredJid(jid)) continue;
      const from = jidToE164(jid) ?? jidToE164(m.key?.remoteJidAlt) ?? jidToE164(m.key?.senderPn);
      if (!from || !m.key?.id) continue; // identifiant masqué (LID) sans numéro : ignoré
      const ts = Number(m.messageTimestamp ?? 0);
      const ev: NormalizedEvent = {
        type: 'inbound_message',
        dedupeKey: `qr:in:${m.key.id}`,
        providerMessageId: String(m.key.id),
        from,
        toPhoneNumberId: null,
        toPhoneNumber: null,
        messageType: typeOf(m),
        text: textOf(m),
        timestamp: ts ? new Date(ts * 1000) : this.ctx.clock.now(),
        raw: { type: typeOf(m) },
      };
      await applyNormalizedEvent(this.ctx, ev, { connectionId: this.connectionId, webhookEventId: null, provider: 'qr', channel: 'QR' });
    }
  }

  private async onUpdates(updates: any[]) {
    for (const u of updates ?? []) {
      const status = STATUS_MAP[u?.update?.status as number];
      if (!u?.key?.fromMe || !u.key.id || !status) continue;
      const ev: NormalizedEvent = {
        type: 'message_status',
        dedupeKey: `qr:st:${u.key.id}:${status}`,
        providerMessageId: String(u.key.id),
        status,
        recipient: jidToE164(u.key.remoteJid),
        timestamp: this.ctx.clock.now(),
        errorCode: null,
        errorMessage: null,
        raw: null,
      };
      await applyNormalizedEvent(this.ctx, ev, { connectionId: this.connectionId, webhookEventId: null, provider: 'qr', channel: 'QR' });
    }
  }
}
