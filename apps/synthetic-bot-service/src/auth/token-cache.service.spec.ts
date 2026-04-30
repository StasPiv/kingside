import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  TOKEN_CACHE_KEY_PREFIX,
  TOKEN_CACHE_REDIS,
  TokenCacheService,
  type RedisLike,
} from './token-cache.service';

function createRedisStub(): RedisLike & {
  store: Map<string, string>;
  setCalls: Array<{ key: string; value: string; ttl: number }>;
  delCalls: string[];
  quit: jest.Mock;
} {
  const store = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string; ttl: number }> = [];
  const delCalls: string[] = [];
  return {
    store,
    setCalls,
    delCalls,
    async get(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string, mode: 'EX', ttl: number) {
      expect(mode).toBe('EX');
      setCalls.push({ key, value, ttl });
      store.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      delCalls.push(key);
      const existed = store.delete(key);
      return existed ? 1 : 0;
    },
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

describe('TokenCacheService', () => {
  let svc: TokenCacheService;
  let redis: ReturnType<typeof createRedisStub>;

  beforeEach(async () => {
    redis = createRedisStub();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: false, ignoreEnvFile: true })],
      providers: [
        TokenCacheService,
        { provide: TOKEN_CACHE_REDIS, useValue: redis },
      ],
    }).compile();
    svc = moduleRef.get(TokenCacheService);
  });

  it('set: SET key value EX ttl с правильным префиксом', async () => {
    await svc.set('user-1', 'jwt-token', 780);
    expect(redis.setCalls).toEqual([
      {
        key: `${TOKEN_CACHE_KEY_PREFIX}user-1`,
        value: 'jwt-token',
        ttl: 780,
      },
    ]);
  });

  it('set: пропускает запись при non-positive TTL', async () => {
    await svc.set('user-1', 'jwt-token', 0);
    await svc.set('user-1', 'jwt-token', -10);
    expect(redis.setCalls).toEqual([]);
  });

  it('get: возвращает токен по корректному ключу', async () => {
    redis.store.set(`${TOKEN_CACHE_KEY_PREFIX}user-1`, 'jwt-cached');
    expect(await svc.get('user-1')).toBe('jwt-cached');
  });

  it('get: null, если ключа нет', async () => {
    expect(await svc.get('absent')).toBeNull();
  });

  it('del: удаляет ключ', async () => {
    redis.store.set(`${TOKEN_CACHE_KEY_PREFIX}user-1`, 'jwt');
    await svc.del('user-1');
    expect(redis.delCalls).toEqual([`${TOKEN_CACHE_KEY_PREFIX}user-1`]);
    expect(redis.store.size).toBe(0);
  });

  it('onModuleDestroy не закрывает injected клиент', async () => {
    await svc.onModuleDestroy();
    expect(redis.quit).not.toHaveBeenCalled();
  });
});
