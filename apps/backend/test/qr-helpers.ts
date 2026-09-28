import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AppContext, ConnectionRow } from '../src/context.js';
import { one } from '../src/db/pool.js';
import { QrConnector, type QrSocketProvider } from '../src/qr/connector.js';
import { qrGate } from '../src/qr/safety.js';
import type { MakeQrSocket, QrSocket } from '../src/qr/socket-port.js';
import { getOrCreateSession, updateSession } from '../src/qr/store.js';
import type { TestEnv } from './helpers.js';

/** Faux socket Baileys : enregistre tout ce que l'application lui demande. */
export class FakeQrSocket implements QrSocket {
  ev = new EventEmitter();
  user: { id: string; name?: string } | undefined = undefined;
  calls: Array<{ type: string; jid?: string; content?: Record<string, unknown>; at: number }> = [];
  failNext: Error | null = null;
  ended = false;
  loggedOut = false;
  private n = 0;
  constructor(private readonly now: () => number) {}
  emit(event: string, arg: unknown) {
    this.ev.emit(event, arg);
  }
  async sendMessage(jid: string, content: Record<string, unknown>) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.calls.push({ type: 'message', jid, content, at: this.now() });
    return { key: { id: `QRMSG${++this.n}` } };
  }
  async sendPresenceUpdate(type: string, jid?: string) {
    this.calls.push({ type: `presence:${type}`, jid, at: this.now() });
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
  messages() {
    return this.calls.filter((c) => c.type === 'message');
  }
}

export function fakeSocketFactory(env: TestEnv) {
  const sockets: FakeQrSocket[] = [];
  const make: MakeQrSocket = () => {
    const s = new FakeQrSocket(() => env.clock.t);
    sockets.push(s);
    return s;
  };
  return { make, sockets };
}

/** Branche le canal QR sur l'environnement de test (connecteur QR réel, socket simulé). */
export function enableQr(env: TestEnv, provider: QrSocketProvider) {
  const fake = env.ctx.connectorFor;
  env.ctx.connectorFor = (conn: ConnectionRow, logCtx) =>
    conn.provider === 'qr' ? new QrConnector(env.ctx as AppContext, provider) : fake(conn, logCtx);
  env.ctx.qrGate = qrGate;
  env.ctx.ffmpegAvailable = true;
  env.ctx.config = { ...env.ctx.config, STEP_GAP_MS: 1000 };
}

/** Session QR déjà connectée (sans passer par Baileys). */
export async function seedQrConnected(env: TestEnv, phone = '+22371111111') {
  const s = await getOrCreateSession(env.db);
  await env.db.query('UPDATE qr_sessions SET paired_at=$2 WHERE id=$1', [s.id, new Date(env.clock.t - 30 * 86_400_000)]);
  await updateSession(env.db, s.id, { status: 'CONNECTED', desired_state: 'RUNNING', phone_number: phone } as never);
  // Heures calmes désactivées par défaut dans les tests (réactivées dans les tests dédiés)
  await env.db.query(`UPDATE qr_settings SET quiet_hours_enabled=false`);
  return (await one(env.db, 'SELECT * FROM qr_sessions WHERE id=$1', [s.id]))!;
}

let cachedMp3: Buffer | null = null;
/** Vrai fichier MP3 (1 s de tonalité) généré par ffmpeg. */
export function sampleMp3(): Buffer {
  if (!cachedMp3) {
    cachedMp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
  }
  return cachedMp3;
}

/** Réglages QR (Automation 1 et 2) avec un audio importé (stockage mémoire) et des images par URL. */
export async function seedQrConfig(env: TestEnv, opts: { delaySeconds?: number; photos?: number } = {}) {
  await env.storage.put('media/audio/test.mp3', sampleMp3(), 'audio/mpeg');
  const audio = await one(
    env.db,
    `INSERT INTO media_assets (kind, source, name, storage_key, mime, size_bytes, duration_ms, status)
     VALUES ('audio','upload','qr-audio.mp3','media/audio/test.mp3','audio/mpeg',1000,1000,'VALID') RETURNING *`,
  );
  const imgs = [];
  for (let i = 0; i < (opts.photos ?? 2); i++) {
    imgs.push(
      await one(
        env.db,
        `INSERT INTO media_assets (kind, source, name, external_url, mime, size_bytes, status)
         VALUES ('image','url',$1,$2,'image/jpeg',1000,'VALID') RETURNING *`,
        [`qr-photo${i + 1}.jpg`, `https://cdn.test/qr-photo${i + 1}.jpg`],
      ),
    );
  }
  await env.db.query(
    `UPDATE automation_configs SET audio_media_id=$1, text1='QR texte 1', text2='QR texte 2', delay_between_contacts_seconds=$2
      WHERE channel='QR' AND automation_type='A1'`,
    [audio.id, opts.delaySeconds ?? 30],
  );
  await env.db.query(
    `UPDATE automation_configs SET audio_media_id=$1, photo_media_ids=$2::uuid[], photo_count=$3, delay_between_contacts_seconds=$4
      WHERE channel='QR' AND automation_type='A2'`,
    [audio.id, imgs.map((m) => m.id), imgs.length, opts.delaySeconds ?? 30],
  );
  return { audio, imgs };
}
