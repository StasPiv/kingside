/**
 * Integration: TokenCacheService против реального Redis.
 *
 * Поднят docker-compose в /project (см. docker-compose.yml). Пробуем оба
 * стандартных порта (6379, 6380) — game-service держит свой Redis на 6380,
 * а в локальной разработке часто 6379. Если ни один не отвечает — пропускаем
 * тест (CI/devops запускает Redis в pipeline отдельно).
 */
import Redis from 'ioredis';
import { TOKEN_CACHE_KEY_PREFIX, TokenCacheService } from './token-cache.service';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const PORTS = [
  parseInt(process.env.REDIS_PORT || '6379', 10),
  6380,
];

async function findReachableRedis(): Promise<Redis | null> {
  for (const port of PORTS) {
    const client = new Redis({
      host: REDIS_HOST,
      port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
    });
    try {
      await client.connect();
      await client.ping();
      return client;
    } catch {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

const KEY_USER = `it-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('TokenCacheService (integration with real Redis)', () => {
  let redis: Redis | null;
  let svc: TokenCacheService;

  beforeAll(async () => {
    redis = await findReachableRedis();
    if (!redis) return;
    // Минимальная фабрика без ConfigService — берём injected клиент.
    svc = new TokenCacheService(
      // ConfigService не нужен, передаём stub с .get → значения по умолчанию.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: (_k: string, def: unknown) => def } as any,
      redis,
    );
  });

  afterAll(async () => {
    if (redis) {
      await redis.del(`${TOKEN_CACHE_KEY_PREFIX}${KEY_USER}`);
      await redis.quit();
    }
  });

  it('set → get → del под реальным ключом synth:tok:<id>', async () => {
    if (!redis) {
      // eslint-disable-next-line no-console
      console.warn('Redis недоступен — integration-тест пропущен');
      return;
    }

    await svc.set(KEY_USER, 'jwt-real-1', 60);

    // Проверяем фактический ключ напрямую — контракт ADR §2.2.
    const direct = await redis.get(`${TOKEN_CACHE_KEY_PREFIX}${KEY_USER}`);
    expect(direct).toBe('jwt-real-1');

    const ttl = await redis.ttl(`${TOKEN_CACHE_KEY_PREFIX}${KEY_USER}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    expect(await svc.get(KEY_USER)).toBe('jwt-real-1');

    await svc.del(KEY_USER);
    expect(await svc.get(KEY_USER)).toBeNull();
  });
});
