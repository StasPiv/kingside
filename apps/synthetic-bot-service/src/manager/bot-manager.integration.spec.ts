/**
 * Integration: BotManager против реального Redis.
 *
 * Проверяет, что:
 *   - SET ... NX EX (canStart) корректно блокирует второго владельца;
 *   - releaseLock() удаляет ключ только если owner === taskId.
 *
 * Если Redis недоступен — тест пропускается с предупреждением (CI/devops
 * сами поднимают Redis в pipeline'е).
 */
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { BotManager, type ManagerRedis } from './bot-manager.service';

const HOST = process.env.REDIS_HOST || 'localhost';
const PORTS = [parseInt(process.env.REDIS_PORT || '6379', 10), 6380];

async function findRedis(): Promise<Redis | null> {
  for (const port of PORTS) {
    const c = new Redis({
      host: HOST,
      port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
    });
    try {
      await c.connect();
      await c.ping();
      return c;
    } catch {
      try {
        await c.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function makeConfig(): ConfigService {
  // Минимальный stub ConfigService.
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (_k: string, def?: unknown) => def,
  } as unknown as ConfigService;
}

describe('BotManager (integration with real Redis)', () => {
  let redis: Redis | null;
  const userId = `it-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockKey = `synth:active:${userId}`;

  beforeAll(async () => {
    redis = await findRedis();
  });

  afterEach(async () => {
    if (redis) await redis.del(lockKey);
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it('Сценарий 2: race — только один task получает лок', async () => {
    if (!redis) {
      // eslint-disable-next-line no-console
      console.warn('Redis недоступен — integration пропущен');
      return;
    }

    const cfg = makeConfig();
    const a = new BotManager(cfg, redis as unknown as ManagerRedis);
    const b = new BotManager(cfg, redis as unknown as ManagerRedis);
    (a as unknown as { taskId: string }).taskId = 'task-A';
    (b as unknown as { taskId: string }).taskId = 'task-B';

    const [okA, okB] = await Promise.all([a.canStart(userId), b.canStart(userId)]);

    // Один из двух — true, другой — false.
    expect([okA, okB].sort()).toEqual([false, true]);
    const owner = await redis.get(lockKey);
    expect(owner).toBe(okA ? 'task-A' : 'task-B');
  });

  it('releaseLock не убирает чужой ключ', async () => {
    if (!redis) return;

    const cfg = makeConfig();
    const a = new BotManager(cfg, redis as unknown as ManagerRedis);
    (a as unknown as { taskId: string }).taskId = 'task-A';

    // Записываем «чужой» лок.
    await redis.set(lockKey, 'task-OTHER', 'EX', 30);
    await a.releaseLock(userId);

    expect(await redis.get(lockKey)).toBe('task-OTHER');
  });
});
