import type { Redis } from 'ioredis';
import type { Clock } from './clock.js';

/**
 * Limite le débit d'envoi par connexion fournisseur (messages / seconde)
 * et respecte les blocages après une réponse 429 (Retry-After).
 * But : démarrer vite sans dépasser les limites du fournisseur, jamais les contourner.
 */
export interface RateLimiter {
  acquire(connectionId: string): Promise<void>;
  block(connectionId: string, ms: number): Promise<void>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly perSecond: number,
    private readonly clock: Clock,
  ) {}

  async acquire(connectionId: string): Promise<void> {
    const windowMs = this.perSecond >= 1 ? 1000 : Math.ceil(1000 / this.perSecond);
    const max = Math.max(1, Math.floor(this.perSecond >= 1 ? this.perSecond : 1));
    for (;;) {
      const blockTtl = await this.redis.pttl(`rl:block:${connectionId}`);
      if (blockTtl > 0) {
        await this.clock.sleep(blockTtl);
        continue;
      }
      const now = this.clock.now().getTime();
      const bucket = Math.floor(now / windowMs);
      const key = `rl:${connectionId}:${bucket}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.pexpire(key, windowMs * 2);
      if (n <= max) return;
      await this.clock.sleep((bucket + 1) * windowMs - now + 5);
    }
  }

  async block(connectionId: string, ms: number) {
    if (ms > 0) await this.redis.set(`rl:block:${connectionId}`, '1', 'PX', Math.ceil(ms));
  }
}

export class NoopRateLimiter implements RateLimiter {
  blocks: Array<{ connectionId: string; ms: number }> = [];
  async acquire() {}
  async block(connectionId: string, ms: number) {
    this.blocks.push({ connectionId, ms });
  }
}
