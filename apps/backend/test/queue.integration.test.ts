import { afterAll, describe, expect, it } from 'vitest';
import { FakeConnector } from '@wa/provider-connectors';
import { Redis } from 'ioredis';
import type { AppContext } from '../src/context.js';
import { one } from '../src/db/pool.js';
import { systemClock } from '../src/lib/clock.js';
import { SecretBox } from '../src/lib/crypto.js';
import { RedisRateLimiter } from '../src/lib/rate-limiter.js';
import { createLogger } from '../src/logger.js';
import { BullScheduler, startWorkers } from '../src/queue/queues.js';
import { createImport } from '../src/services/imports.js';
import { createRun, recoverRuns } from '../src/services/runs.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { closeDb, phones, resetDb, seedA1Config, seedA2Config, seedConnection, testConfig, TEST_REDIS_URL } from './helpers.js';

/**
 * Test d'intégration avec de vrais BullMQ / Redis / PostgreSQL et l'horloge réelle.
 * Vérifie que le délai Automation 2 est respecté par les jobs retardés et que la reprise fonctionne.
 */
describe('Intégration BullMQ + Redis (horloge réelle)', () => {
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c().catch(() => undefined);
    await redis.quit();
    await closeDb();
  });

  async function env() {
    await redis.flushdb();
    const db = await resetDb();
    const config = testConfig({ STEP_GAP_MS: '50', A1_CONCURRENCY: '4', PROVIDER_MAX_MESSAGES_PER_SECOND: '50' });
    const fake = new FakeConnector();
    let ctx!: AppContext;
    const scheduler = new BullScheduler(redis.duplicate(), () => ctx);
    ctx = {
      config,
      db,
      redis,
      log: createLogger('silent'),
      secrets: new SecretBox(config.ENCRYPTION_KEY),
      clock: systemClock,
      storage: new MemoryStorage(),
      rateLimiter: new RedisRateLimiter(redis, config.PROVIDER_MAX_MESSAGES_PER_SECOND, systemClock),
      scheduler,
      connectorFor: () => fake,
      ffmpegAvailable: false,
    };
    cleanup.push(() => scheduler.close());
    const e = { ctx, db, fake, scheduler } as any;
    await seedConnection(e);
    return e as { ctx: AppContext; db: typeof db; fake: FakeConnector; scheduler: BullScheduler };
  }

  async function waitFor(fn: () => Promise<boolean>, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  }

  it('Automation 2 : délai de 2 s réellement respecté entre contacts, un à la fois', async () => {
    const e = await env();
    await seedA2Config(e as any, 2, 2);
    const workers = startWorkers(e.ctx, redis.duplicate());
    cleanup.push(() => workers.close());
    const imp = await createImport(e.ctx, { automationType: 'A2', source: 'paste', content: phones(3).join('\n') });
    const { run } = await createRun(e.ctx, { type: 'A2', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'int-a2' });
    await waitFor(async () => (await one(e.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id])).status === 'COMPLETED', 20_000);
    await workers.close();
    const byContact = phones(3).map((p) => e.fake.sends.filter((s) => s.to === p).map((s) => s.at));
    expect(byContact.map((x) => x.length)).toEqual([3, 3, 3]);
    for (let i = 1; i < 3; i++) {
      const gap = byContact[i]![0]! - byContact[i - 1]!.at(-1)!;
      expect(gap).toBeGreaterThanOrEqual(2000);
      expect(gap).toBeLessThan(4000);
    }
  });

  it('Automation 1 : traitement parallèle contrôlé, tous les contacts servis une seule fois', async () => {
    const e = await env();
    await seedA1Config(e as any);
    const workers = startWorkers(e.ctx, redis.duplicate());
    cleanup.push(() => workers.close());
    const imp = await createImport(e.ctx, { automationType: 'A1', source: 'paste', content: phones(20).join('\n') });
    const { run } = await createRun(e.ctx, { type: 'A1', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'int-a1' });
    // Balayage de reprise concurrent : ne doit provoquer aucun doublon
    await recoverRuns(e.ctx);
    await waitFor(async () => (await one(e.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id])).status === 'COMPLETED', 20_000);
    await recoverRuns(e.ctx);
    await new Promise((r) => setTimeout(r, 500));
    await workers.close();
    expect(e.fake.sends).toHaveLength(60);
    expect(new Set(e.fake.sends.map((s) => `${s.to}:${s.message.kind}:${(s.message as any).body ?? ''}`)).size).toBe(60);
  });

  it('redémarrage du worker pendant Automation 2 : reprise au bon contact depuis PostgreSQL', async () => {
    const e = await env();
    await seedA2Config(e as any, 1, 1);
    let workers = startWorkers(e.ctx, redis.duplicate());
    const imp = await createImport(e.ctx, { automationType: 'A2', source: 'paste', content: phones(4).join('\n') });
    const { run } = await createRun(e.ctx, { type: 'A2', kind: 'SEQUENCE', importId: imp.importId, clientRequestId: 'int-restart' });
    await waitFor(async () => e.fake.sends.length >= 2, 10_000); // contact 1 terminé
    await workers.close();
    await redis.flushdb(); // perte totale de Redis
    workers = startWorkers(e.ctx, redis.duplicate()); // le démarrage lance recoverRuns()
    cleanup.push(() => workers.close());
    await waitFor(async () => (await one(e.db, 'SELECT status FROM automation_runs WHERE id=$1', [run.id])).status === 'COMPLETED', 20_000);
    await workers.close();
    expect(e.fake.sends.map((s) => s.to).filter((v, i, a) => a.indexOf(v) === i)).toEqual(phones(4));
    expect(e.fake.sends).toHaveLength(8);
  });
});
