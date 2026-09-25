import { FakeConnector } from '@wa/provider-connectors';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { AppContext, ConnectionRow } from '../src/context.js';
import { createPool, one, type Db } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { SecretBox } from '../src/lib/crypto.js';
import { NoopRateLimiter } from '../src/lib/rate-limiter.js';
import { createLogger } from '../src/logger.js';
import type { JobScheduler } from '../src/queue/scheduler.js';
import { a2Tick, handleRecipientJob } from '../src/services/engine.js';
import { processWebhookEvent } from '../src/services/webhooks.js';
import { MemoryStorage } from '../src/storage/storage.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/app_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export function testConfig(over: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    REDIS_URL: TEST_REDIS_URL,
    ENCRYPTION_KEY: '0'.repeat(64),
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234567890',
    PUBLIC_BACKEND_URL: 'https://backend.test',
    LOG_LEVEL: 'silent',
    STEP_GAP_MS: '1000',
    RETRY_BASE_MS: '2000',
    SEND_MAX_ATTEMPTS: '4',
    ...over,
  });
}

/** Horloge virtuelle : sleep() avance le temps instantanément. */
export class FakeClock {
  t = Date.parse('2026-01-01T10:00:00Z');
  sleeps: number[] = [];
  now = () => new Date(this.t);
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += Math.max(0, ms);
  };
}

/** Planificateur mémoire qui simule BullMQ (jobs retardés) avec l'horloge virtuelle. */
export class SimScheduler implements JobScheduler {
  recipientJobs: Array<{ runId: string; recipientId: string; epoch: number }> = [];
  ticks = new Map<string, { runId: string; seq: number; due: number }>();
  webhookJobs: string[] = [];
  constructor(private clock: FakeClock) {}
  async enqueueRecipient(runId: string, recipientId: string, epoch: number) {
    const dup = this.recipientJobs.some((j) => j.recipientId === recipientId && j.epoch === epoch);
    if (!dup) this.recipientJobs.push({ runId, recipientId, epoch });
  }
  async scheduleA2Tick(runId: string, seq: number, delayMs: number) {
    this.ticks.set(`${runId}:${seq}`, { runId, seq, due: this.clock.t + Math.max(0, delayMs) });
  }
  async enqueueWebhookEvent(eventId: string) {
    this.webhookJobs.push(eventId);
  }
}

export interface TestEnv {
  ctx: AppContext;
  db: Db;
  clock: FakeClock;
  sched: SimScheduler;
  fake: FakeConnector;
  storage: MemoryStorage;
  limiter: NoopRateLimiter;
}

let sharedDb: Db | null = null;

export async function resetDb(): Promise<Db> {
  if (!sharedDb) sharedDb = createPool(TEST_DB_URL);
  await sharedDb.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(sharedDb);
  return sharedDb;
}

export async function closeDb() {
  await sharedDb?.end();
  sharedDb = null;
}

export async function createTestEnv(over: Partial<Record<string, string>> = {}): Promise<TestEnv> {
  const db = await resetDb();
  const config = testConfig(over);
  const clock = new FakeClock();
  const sched = new SimScheduler(clock);
  const fake = new FakeConnector();
  fake.now = () => clock.t;
  fake.sleep = clock.sleep;
  const storage = new MemoryStorage();
  const limiter = new NoopRateLimiter();
  const ctx: AppContext = {
    config,
    db,
    redis: null,
    log: createLogger('silent'),
    secrets: new SecretBox(config.ENCRYPTION_KEY),
    clock,
    storage,
    rateLimiter: limiter,
    scheduler: sched,
    connectorFor: (_conn: ConnectionRow) => fake,
    ffmpegAvailable: false,
  };
  return { ctx, db, clock, sched, fake, storage, limiter };
}

export async function seedConnection(env: TestEnv, opts: { mode?: 'PRODUCTION' | 'TEST'; phone?: string } = {}) {
  const phone = opts.phone ?? '+22370000000';
  const c = await one(
    env.db,
    `INSERT INTO provider_connections (provider, label, mode, status, api_key_enc, api_key_hint, webhook_secret_enc,
        project_id, project_name, waba_id, phone_number_id, phone_number, number_status)
     VALUES ('sendzen','SendZen',$1,'CONNECTED',$2,'sk_live_***789',$3,'1','Projet test','waba-1','pn-1',$4,'CONNECTED') RETURNING *`,
    [opts.mode ?? 'PRODUCTION', env.ctx.secrets.encrypt('sk_live_secret_key_789'), env.ctx.secrets.encrypt('test-secret'), phone],
  );
  await env.db.query(
    `INSERT INTO whatsapp_numbers (phone_e164, provider, phone_number_id, last_connection_id) VALUES ($1,'sendzen','pn-1',$2)
     ON CONFLICT (phone_e164) DO UPDATE SET last_connection_id=EXCLUDED.last_connection_id`,
    [phone, c.id],
  );
  await env.db.query('UPDATE app_settings SET active_connection_id=$1 WHERE id=1', [c.id]);
  return c;
}

export async function seedMedia(env: TestEnv, kind: 'audio' | 'image', name: string) {
  return one(
    env.db,
    `INSERT INTO media_assets (kind, source, name, external_url, mime, size_bytes, duration_ms, status)
     VALUES ($1,'url',$2,$3,$4,1000,$5,'VALID') RETURNING *`,
    [kind, name, `https://cdn.test/${name}`, kind === 'audio' ? 'audio/ogg' : 'image/jpeg', kind === 'audio' ? 90_000 : null],
  );
}

export async function seedA1Config(env: TestEnv) {
  const audio = await seedMedia(env, 'audio', 'audio1.ogg');
  await env.db.query(`UPDATE automation_configs SET audio_media_id=$1, text1='Bonjour 1', text2='Texte 2' WHERE automation_type='A1'`, [audio.id]);
  return { audio };
}

export async function seedA2Config(env: TestEnv, photos = 3, delaySeconds = 10) {
  const audio = await seedMedia(env, 'audio', 'audio2.ogg');
  const imgs = [];
  for (let i = 0; i < photos; i++) imgs.push(await seedMedia(env, 'image', `photo${i + 1}.jpg`));
  await env.db.query(
    `UPDATE automation_configs SET audio_media_id=$1, photo_media_ids=$2::uuid[], photo_count=$3, delay_between_contacts_seconds=$4 WHERE automation_type='A2'`,
    [audio.id, imgs.map((m) => m.id), photos, delaySeconds],
  );
  return { audio, imgs };
}

export function phones(n: number, start = 0) {
  return Array.from({ length: n }, (_, i) => `+2237600${String(start + i).padStart(4, '0')}`);
}

/** Exécute les jobs Automation 1 en attente (comme le ferait le worker). */
export async function drainRecipients(env: TestEnv) {
  let n = 0;
  while (env.sched.recipientJobs.length) {
    const j = env.sched.recipientJobs.shift()!;
    await handleRecipientJob(env.ctx, j.runId, j.recipientId);
    n++;
  }
  return n;
}

/** Exécute les ticks Automation 2 dans l'ordre chronologique virtuel. */
export async function drainA2(env: TestEnv, opts: { maxTicks?: number; until?: () => boolean } = {}) {
  let n = 0;
  while (env.sched.ticks.size && n < (opts.maxTicks ?? 1000)) {
    if (opts.until?.()) break;
    const [key, next] = [...env.sched.ticks.entries()].sort((a, b) => a[1].due - b[1].due)[0]!;
    env.sched.ticks.delete(key);
    if (next.due > env.clock.t) env.clock.t = next.due;
    await a2Tick(env.ctx, next.runId, next.seq);
    n++;
  }
  return n;
}

export async function drainWebhooks(env: TestEnv) {
  while (env.sched.webhookJobs.length) await processWebhookEvent(env.ctx, env.sched.webhookJobs.shift()!);
}
