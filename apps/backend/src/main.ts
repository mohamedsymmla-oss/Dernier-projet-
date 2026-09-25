import { bootstrapAdmin } from './auth.js';
import { buildApp } from './app.js';
import { createProductionContext } from './bootstrap.js';
import { runMigrations } from './db/migrate.js';
import { startWorkers } from './queue/queues.js';

async function main() {
  const { ctx, scheduler } = await createProductionContext();
  const { config, log } = ctx;
  await runMigrations(ctx.db, (m) => log.info(m));
  await bootstrapAdmin(ctx);

  const closers: Array<() => Promise<unknown>> = [];
  if (config.APP_ROLE === 'worker' || config.APP_ROLE === 'all') {
    const workers = startWorkers(ctx, ctx.redis!.duplicate());
    closers.push(() => workers.close());
    log.info({ role: config.APP_ROLE }, 'workers_started');
  }
  if (config.APP_ROLE === 'api' || config.APP_ROLE === 'all') {
    const app = await buildApp(ctx);
    await app.listen({ port: config.PORT, host: config.HOST });
    closers.push(() => app.close());
  }
  log.info(
    { storage: ctx.storage.description, ffmpeg: ctx.ffmpegAvailable, public_url: config.PUBLIC_BACKEND_URL ?? null },
    'server_ready',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown');
    // Arrêt propre : les jobs en cours se terminent ; les autres restent dans Redis/PostgreSQL et reprennent au redémarrage.
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await scheduler.close().catch(() => undefined);
    await ctx.redis?.quit().catch(() => undefined);
    await ctx.db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
