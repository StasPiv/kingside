import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const DEFAULT_TTL_SEC = 60;

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  /** In-flight promises to prevent thundering herd */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Get cached value or compute it.
   * Coalesces concurrent requests for the same key — only one compute() runs,
   * others wait for the same promise (thundering herd protection).
   * @param key Redis key
   * @param ttlSec TTL in seconds (default 60)
   * @param compute Function to compute the value if not cached
   */
  async getOrSet<T>(key: string, ttlSec: number = DEFAULT_TTL_SEC, compute: () => Promise<T>): Promise<T> {
    // Check Redis cache first
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis error — compute fresh
    }

    // Coalesce: if another request is already computing this key, wait for it
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = this.computeAndCache<T>(key, ttlSec, compute);
    this.inflight.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async computeAndCache<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
    const value = await compute();

    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
    } catch {
      // Redis error — still return computed value
    }

    return value;
  }

  async invalidate(pattern: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch {
      // Redis error — ignore
    }
  }
}
