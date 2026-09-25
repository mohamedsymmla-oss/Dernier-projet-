import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppContext } from '../context.js';
import { a2Tick, handleRecipientJob } from '../services/engine.js';
import { recoverRuns } from '../services/runs.js';
import { processWebhookEvent } from '../services/webhooks.js';
import type { JobScheduler } from './scheduler.js';

export const QUEUE_NAMES = {
  recipients: 'a1-recipients',
  a2: 'a2-sequential',
  webhooks: 'webhook-events',
} as const;

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

/**
 * Files BullMQ persistées dans Redis. PostgreSQL reste la source de vérité :
 * si Redis est vidé, recoverRuns() reconstruit les jobs à partir de la base.
 */
export class BullScheduler implements JobScheduler {
  readonly recipients: Queue;
  readonly a2: Queue;
  readonly webhooks: Queue;

  constructor(
    connection: ConnectionOptions,
    private readonly ctxRef: () => AppContext,
  ) {
    const defaults = { removeOnComplete: { age: 24 * 3600, count: 5000 }, removeOnFail: { age: 7 * 24 * 3600 } };
    this.recipients = new Queue(QUEUE_NAMES.recipients, { connection, defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: 5000 } } });
    this.a2 = new Queue(QUEUE_NAMES.a2, { connection, defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: 5000 } } });
    this.webhooks = new Queue(QUEUE_NAMES.webhooks, { connection, defaultJobOptions: { ...defaults, attempts: 8, backoff: { type: 'exponential', delay: 3000 } } });
  }

  private async track(queue: string, jobId: string, runId: string | null, recipientId: string | null, delayMs = 0) {
    const ctx = this.ctxRef();
    await ctx.db
      .query(
        `INSERT INTO queue_jobs (queue, job_id, run_id, recipient_id, status, scheduled_for)
         VALUES ($1,$2,$3,$4,'QUEUED', now() + ($5 || ' milliseconds')::interval)
         ON CONFLICT (queue, job_id) DO UPDATE SET scheduled_for=EXCLUDED.scheduled_for, updated_at=now()`,
        [queue, jobId, runId, recipientId, String(Math.round(delayMs))],
      )
      .catch(() => undefined);
  }

  async enqueueRecipient(runId: string, recipientId: string, epoch: number) {
    const jobId = `r_${recipientId}_${epoch}`;
    await this.recipients.add('recipient', { runId, recipientId }, { jobId });
    await this.track(QUEUE_NAMES.recipients, jobId, runId, recipientId);
  }

  async scheduleA2Tick(runId: string, seq: number, delayMs: number) {
    const jobId = `a2_${runId}_${seq}`;
    const existing = await this.a2.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'delayed' || state === 'waiting') {
        // Reprogrammation (ex : délai modifié) : on remplace le job en attente.
        await existing.remove().catch(() => undefined);
      } else if (state === 'active') {
        return;
      } else {
        await existing.remove().catch(() => undefined);
      }
    }
    await this.a2.add('tick', { runId, seq }, { jobId, delay: Math.max(0, Math.round(delayMs)) });
    await this.track(QUEUE_NAMES.a2, jobId, runId, null, delayMs);
  }

  async enqueueWebhookEvent(eventId: string) {
    await this.webhooks.add('event', { eventId }, { jobId: `wh_${eventId}` });
  }

  async close() {
    await Promise.all([this.recipients.close(), this.a2.close(), this.webhooks.close()]);
  }
}

async function markJob(ctx: AppContext, queue: string, job: Job, status: string, error?: string) {
  await ctx.db
    .query(`UPDATE queue_jobs SET status=$3, attempts=$4, last_error=$5, updated_at=now() WHERE queue=$1 AND job_id=$2`, [
      queue,
      job.id,
      status,
      job.attemptsMade,
      error ?? null,
    ])
    .catch(() => undefined);
}

export function startWorkers(ctx: AppContext, connection: ConnectionOptions) {
  const log = ctx.log.child({ component: 'worker' });

  const recipients = new Worker(
    QUEUE_NAMES.recipients,
    async (job) => {
      const { runId, recipientId } = job.data as { runId: string; recipientId: string };
      await markJob(ctx, QUEUE_NAMES.recipients, job, 'ACTIVE');
      return handleRecipientJob(ctx, runId, recipientId);
    },
    { connection, concurrency: ctx.config.A1_CONCURRENCY, lockDuration: 120_000 },
  );

  // Automation 2 : concurrence 1 → jamais deux contacts traités en même temps.
  const a2 = new Worker(
    QUEUE_NAMES.a2,
    async (job) => {
      const { runId, seq } = job.data as { runId: string; seq: number };
      await markJob(ctx, QUEUE_NAMES.a2, job, 'ACTIVE');
      return a2Tick(ctx, runId, seq);
    },
    { connection, concurrency: 1, lockDuration: 300_000 },
  );

  const webhooks = new Worker(
    QUEUE_NAMES.webhooks,
    async (job) => processWebhookEvent(ctx, (job.data as { eventId: string }).eventId),
    { connection, concurrency: 5 },
  );

  for (const [name, w] of [
    [QUEUE_NAMES.recipients, recipients],
    [QUEUE_NAMES.a2, a2],
  ] as const) {
    w.on('completed', (job) => void markJob(ctx, name, job, 'COMPLETED'));
    w.on('failed', (job, err) => {
      log.error({ queue: name, job_id: job?.id, err: err.message }, 'job_failed');
      if (job) void markJob(ctx, name, job, 'FAILED', err.message);
    });
  }
  webhooks.on('failed', (job, err) => log.error({ job_id: job?.id, err: err.message }, 'webhook_job_failed'));

  // Reprise après redémarrage + balayage périodique (jobs perdus, webhooks non traités).
  const sweep = async () => {
    try {
      const r = await recoverRuns(ctx);
      if (r.runs || r.webhooks) log.info(r, 'recovery_sweep');
    } catch (e) {
      log.error({ err: e }, 'recovery_failed');
    }
  };
  void sweep();
  const timer = setInterval(sweep, 60_000);

  return {
    async close() {
      clearInterval(timer);
      await Promise.all([recipients.close(), a2.close(), webhooks.close()]);
    },
  };
}
