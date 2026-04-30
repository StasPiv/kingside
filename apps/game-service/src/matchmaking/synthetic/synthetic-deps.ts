/**
 * KS-2164. Узкие интерфейсы Prisma/Redis, которые нужны
 * synthetic-сервисам. Тесты подменяют реализациями без поднятия Nest.
 */

import type { LiveQueueRedis } from './live-queue-stats';

export interface SyntheticPrisma {
  user: {
    findMany(args: {
      where: { isSynthetic: boolean };
      select: { id: boolean };
    }): Promise<Array<{ id: string }>>;
    updateMany(args: {
      where: { id: { in: string[] } };
      data: { lastSeenAt: Date };
    }): Promise<{ count: number }>;
  };
}

/**
 * Redis-минимум: SET / GET / DEL для state'ов + LiveQueue ops + EX-TTL.
 */
export interface SyntheticRedis extends LiveQueueRedis {
  set(
    key: string,
    value: string,
    mode?: 'EX',
    ttl?: number,
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface SyntheticDeps {
  prisma: SyntheticPrisma;
  redis: SyntheticRedis;
}
