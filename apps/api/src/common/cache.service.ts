import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const DEFAULT_TTL_SEC = 60;

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Get cached value or compute it.
   * @param key Redis key
   * @param ttlSec TTL in seconds (default 60)
   * @param compute Function to compute the value if not cached
   */
  async getOrSet<T>(key: string, ttlSec: number = DEFAULT_TTL_SEC, compute: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis error — compute fresh
    }

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
