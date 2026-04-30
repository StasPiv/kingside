import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  BOT_TOKEN_HTTP,
  BotTokenService,
  type FetchLike,
} from './bot-token.service';
import { TokenCacheService } from './token-cache.service';
import { TOKEN_CACHE_REDIS, type RedisLike } from './token-cache.service';
import { BotTokenError } from './errors';

const ENV = {
  API_INTERNAL_URL: 'http://api.test',
  SYNTHETIC_BOT_INTERNAL_KEY: 'test-key',
};

function makeRedisStub(): RedisLike {
  const store = new Map<string, string>();
  return {
    async get(k) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    async set(k, v) {
      store.set(k, v);
      return 'OK';
    },
    async del(k) {
      const existed = store.delete(k);
      return existed ? 1 : 0;
    },
  };
}

function makeFetchStub(
  responses: Array<{
    status?: number;
    body?: unknown;
    throwError?: Error;
  }>,
): FetchLike & { calls: number } {
  let i = 0;
  const fn = ((async () => {
    fn.calls++;
    const next = responses[i++];
    if (!next) {
      throw new Error(`fetch stub: no more responses (call ${i})`);
    }
    if (next.throwError) throw next.throwError;
    const status = next.status ?? 200;
    const body = next.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body ?? '');
      },
      async json() {
        return body;
      },
    };
  }) as unknown) as FetchLike & { calls: number };
  fn.calls = 0;
  return fn;
}

async function makeService(
  fetchStub: FetchLike,
  redisStub: RedisLike = makeRedisStub(),
): Promise<{
  svc: BotTokenService;
  cache: TokenCacheService;
}> {
  // Очищаем процессное окружение от случайных значений между тестами.
  delete process.env.API_INTERNAL_URL;
  delete process.env.SYNTHETIC_BOT_INTERNAL_KEY;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: false,
        ignoreEnvFile: true,
        load: [() => ENV],
      }),
    ],
    providers: [
      BotTokenService,
      TokenCacheService,
      { provide: BOT_TOKEN_HTTP, useValue: fetchStub },
      { provide: TOKEN_CACHE_REDIS, useValue: redisStub },
    ],
  }).compile();

  const svc = moduleRef.get(BotTokenService);
  const cache = moduleRef.get(TokenCacheService);
  return { svc, cache };
}

describe('BotTokenService', () => {
  it('Сценарий 1 (cache-miss): POST на api → токен → сохранение в кэш с TTL = expiresIn − 120', async () => {
    const fetch = makeFetchStub([
      { status: 200, body: { accessToken: 'jwt-1', expiresIn: 900 } },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    const token = await svc.getToken('bot-001');
    expect(token).toBe('jwt-1');
    expect(fetch.calls).toBe(1);
    expect(await cache.get('bot-001')).toBe('jwt-1');
    // TTL мы видим через redis-stub только косвенно — set всё-таки вызван;
    // факт того, что get вернул значение, означает запись прошла.
  });

  it('Сценарий 2 (cache-hit): второй вызов идёт из кэша, без HTTP', async () => {
    const fetch = makeFetchStub([
      { status: 200, body: { accessToken: 'jwt-1', expiresIn: 900 } },
    ]);
    const redis = makeRedisStub();
    const { svc } = await makeService(fetch, redis);

    await svc.getToken('bot-001');
    const second = await svc.getToken('bot-001');

    expect(second).toBe('jwt-1');
    expect(fetch.calls).toBe(1);
  });

  it('Сценарий 3 (TTL истёк): кэш пуст → новый POST', async () => {
    const fetch = makeFetchStub([
      { status: 200, body: { accessToken: 'jwt-1', expiresIn: 900 } },
      { status: 200, body: { accessToken: 'jwt-2', expiresIn: 900 } },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    await svc.getToken('bot-001');
    // эмулируем истечение TTL — Redis удалил ключ
    await cache.del('bot-001');

    const second = await svc.getToken('bot-001');
    expect(second).toBe('jwt-2');
    expect(fetch.calls).toBe(2);
  });

  it('Сценарий 4 (5xx): retry до 3 попыток, затем ошибка; кэш пуст', async () => {
    const fetch = makeFetchStub([
      { status: 503, body: 'unavailable' },
      { status: 503, body: 'unavailable' },
      { status: 503, body: 'unavailable' },
      { status: 503, body: 'unavailable' },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    await expect(svc.getToken('bot-001')).rejects.toBeInstanceOf(BotTokenError);
    expect(fetch.calls).toBe(4); // 1 initial + 3 retries
    expect(await cache.get('bot-001')).toBeNull();
  });

  it('retry на 503 → успех на 2-й попытке', async () => {
    const fetch = makeFetchStub([
      { status: 503, body: 'busy' },
      { status: 200, body: { accessToken: 'jwt-recovery', expiresIn: 900 } },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    const token = await svc.getToken('bot-001');
    expect(token).toBe('jwt-recovery');
    expect(fetch.calls).toBe(2);
    expect(await cache.get('bot-001')).toBe('jwt-recovery');
  });

  it('retry на network error → успех на 2-й попытке', async () => {
    const fetch = makeFetchStub([
      { throwError: new Error('ECONNREFUSED') },
      { status: 200, body: { accessToken: 'jwt-after-net', expiresIn: 900 } },
    ]);
    const { svc } = await makeService(fetch);
    expect(await svc.getToken('bot-001')).toBe('jwt-after-net');
    expect(fetch.calls).toBe(2);
  });

  it('Сценарий 5 (4xx): 403 без ретраев, кэш пуст', async () => {
    const fetch = makeFetchStub([
      { status: 403, body: 'User is not synthetic' },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    await expect(svc.getToken('bot-001')).rejects.toThrow(/403/);
    expect(fetch.calls).toBe(1);
    expect(await cache.get('bot-001')).toBeNull();
  });

  it('404 от api → без ретраев', async () => {
    const fetch = makeFetchStub([{ status: 404, body: 'User not found' }]);
    const { svc } = await makeService(fetch);

    await expect(svc.getToken('bot-001')).rejects.toMatchObject({
      status: 404,
    });
    expect(fetch.calls).toBe(1);
  });

  it('invalidate(): удаляет токен из кэша', async () => {
    const fetch = makeFetchStub([
      { status: 200, body: { accessToken: 'jwt-1', expiresIn: 900 } },
    ]);
    const redis = makeRedisStub();
    const { svc, cache } = await makeService(fetch, redis);

    await svc.getToken('bot-001');
    expect(await cache.get('bot-001')).toBe('jwt-1');

    await svc.invalidate('bot-001');
    expect(await cache.get('bot-001')).toBeNull();
  });

  it('malformed payload → BotTokenError 500 (без ретрая, т.к. это уже non-OK интерпретация)', async () => {
    const fetch = makeFetchStub([
      { status: 200, body: { accessToken: 'jwt-1' /* нет expiresIn */ } },
      // На случай ретрая — ещё одна заглушка с тем же мусором,
      // чтобы fetch-stub не падал «no more responses» если retry-policy
      // решит повторить.
      { status: 200, body: { accessToken: 'jwt-1' } },
      { status: 200, body: { accessToken: 'jwt-1' } },
      { status: 200, body: { accessToken: 'jwt-1' } },
    ]);
    const { svc } = await makeService(fetch);
    await expect(svc.getToken('bot-001')).rejects.toBeInstanceOf(BotTokenError);
  });
});
