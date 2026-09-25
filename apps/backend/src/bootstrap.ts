import type { Redis } from 'ioredis';
import { loadConfig, type AppConfig } from './config.js';
import { productionConnectorFactory, type AppContext } from './context.js';
import { createPool } from './db/pool.js';
import { systemClock } from './lib/clock.js';
import { SecretBox } from './lib/crypto.js';
import { RedisRateLimiter } from './lib/rate-limiter.js';
import { createLogger } from './logger.js';
import { BullScheduler, createRedis } from './queue/queues.js';
import { ffmpegAvailable } from './services/media.js';
import { createStorage } from './storage/storage.js';

export async function createProductionContext(config: AppConfig = loadConfig()) {
  const log = createLogger(config.LOG_LEVEL);
  const db = createPool(config.DATABASE_URL, config.DATABASE_SSL);
  const redis: Redis = createRedis(config.REDIS_URL);
  const secrets = new SecretBox(config.ENCRYPTION_KEY);
  let ctx!: AppContext;
  const scheduler = new BullScheduler(redis.duplicate(), () => ctx);
  const base = {
    config,
    db,
    redis,
    log,
    secrets,
    clock: systemClock,
    storage: createStorage(config),
    rateLimiter: new RedisRateLimiter(redis, config.PROVIDER_MAX_MESSAGES_PER_SECOND, systemClock),
    scheduler,
    ffmpegAvailable: await ffmpegAvailable(),
  };
  ctx = { ...base, connectorFor: productionConnectorFactory(base) };
  return { ctx, scheduler };
}
