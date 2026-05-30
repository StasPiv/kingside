/**
 * KS-2158. Тесты watchdog-логики (`runWatchdogTick`). Покрывают 5 acceptance-сценариев:
 *   1. ongoing + lichess 404 → закрываем `finished`.
 *   2. ongoing + lichess 200 + только финальные результаты → `finished`.
 *   3. ongoing + lichess 200 + есть `[Result "*"]` → live, НЕ закрываем.
 *   4. ongoing + lichess 5xx (1-2 раза) → не закрываем, инкрементим fail-counter.
 *   5. ongoing + lichess 5xx 3 раза подряд → закрываем `failed`.
 *
 * Тестируется чистая функция `runWatchdogTick` с подменяемыми
 * `prisma`/`redis`/`fetchFn` — без поднятия NestJS.
 */
import {
  BroadcastWatchdogService,
  runWatchdogTick,
  type WatchdogPrisma,
  type WatchdogRedis,
} from './broadcast-watchdog.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

interface FakeRound {
  id: string;
  lichess_round_id: string;
  broadcast_id: string;
  last_update_at: Date;
}

function makePrisma(
  rounds: FakeRound[],
  broadcasts: Record<string, { lichessId: string }> = {},
) {
  const updates: Array<{ id: string; data: { status: string } }> = [];
  return {
    _updates: updates,
    $queryRawUnsafe: jest.fn(async () => rounds),
    broadcastRound: {
      update: jest.fn(
        async (args: { where: { id: string }; data: { status: string } }) => {
          updates.push({ id: args.where.id, data: args.data });
          return { id: args.where.id, ...args.data };
        },
      ),
    },
    // KS-3332: для tour-API guard в applyDecision.
    broadcast: {
      findUnique: jest.fn(
        async (args: {
          where: { id: string };
          select: { lichessId: true };
        }) => broadcasts[args.where.id] ?? null,
      ),
    },
  } as unknown as WatchdogPrisma & { _updates: typeof updates };
}

function makeRedis() {
  const counts: Record<string, number> = {};
  const expires: Record<string, number> = {};
  const dels: string[] = [];
  return {
    _counts: counts,
    _expires: expires,
    _dels: dels,
    set: jest.fn(async () => 'OK' as const),
    incr: jest.fn(async (k: string) => {
      counts[k] = (counts[k] ?? 0) + 1;
      return counts[k];
    }),
    expire: jest.fn(async (k: string, ttl: number) => {
      expires[k] = ttl;
      return 1;
    }),
    del: jest.fn(async (k: string) => {
      dels.push(k);
      if (k in counts) {
        delete counts[k];
        return 1;
      }
      return 0;
    }),
  } as unknown as WatchdogRedis & {
    _counts: typeof counts;
    _expires: typeof expires;
    _dels: typeof dels;
  };
}

function makeLogger() {
  const lines: string[] = [];
  return {
    _lines: lines,
    log: (m: string) => lines.push(`log:  ${m}`),
    warn: (m: string) => lines.push(`warn: ${m}`),
    error: (m: string) => lines.push(`err:  ${m}`),
  };
}

function fakeRound(overrides: Partial<FakeRound> = {}): FakeRound {
  return {
    id: 'round-1',
    lichess_round_id: 'lichess-r1',
    broadcast_id: 'b-1',
    last_update_at: new Date(Date.now() - 60 * 60 * 1000), // 1 ч назад
    ...overrides,
  };
}

function mockFetch(
  cases: Array<{
    status: number;
    body?: string;
    throws?: Error;
  }>,
) {
  let i = 0;
  return jest.fn(async () => {
    const c = cases[Math.min(i++, cases.length - 1)];
    if (c.throws) throw c.throws;
    return new Response(c.body ?? '', { status: c.status }) as Response;
  });
}

const PGN_ALL_FINISHED = `
[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0

[Event "Test"]
[White "C"]
[Black "D"]
[Result "1/2-1/2"]

1. d4 d5 1/2-1/2
`.trim();

const PGN_HAS_ONGOING = `
[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0

[Event "Test"]
[White "C"]
[Black "D"]
[Result "*"]

1. d4 d5 *
`.trim();

describe('runWatchdogTick — KS-2158', () => {
  it('лиц 404 → round закрывается status=finished, fail-counter не ставится', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 404 }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.scanned).toBe(1);
    expect(r.outcomes[0].outcome).toBe('closed-finished');
    expect((prisma as unknown as { _updates: { id: string; data: { status: string } }[] })._updates)
      .toEqual([{ id: 'round-1', data: { status: 'finished' } }]);
    expect(logger._lines.find((l) => l.includes('closed (status=finished'))).toBeTruthy();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('лиц 200 + все игры с финальным результатом → round закрывается finished', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 200, body: PGN_ALL_FINISHED }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('closed-finished');
    expect(r.outcomes[0].reason).toMatch(/all games have final result/);
    expect((prisma as unknown as { _updates: { id: string; data: { status: string } }[] })._updates[0].data.status).toBe('finished');
  });

  it('лиц 200 + есть [Result "*"] (медленная игра) → round НЕ закрывается, fail-counter сбрасывается', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    // Предполагаем, что был накопленный fail-counter (например от прошлого 5xx) —
    // успешный live-ответ должен его сбросить.
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2;
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 200, body: PGN_HAS_ONGOING }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-live');
    expect((prisma as unknown as { _updates: unknown[] })._updates).toHaveLength(0);
    expect(redis._dels).toContain('broadcast:watchdog:fail-count:round-1');
    expect(logger._lines.find((l) => l.includes('stale-but-source-live'))).toBeTruthy();
  });

  it('лиц 5xx (1 раз) → НЕ закрывается, fail-counter=1', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 503 }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect((prisma as unknown as { _updates: unknown[] })._updates).toHaveLength(0);
    expect(redis._counts['broadcast:watchdog:fail-count:round-1']).toBe(1);
    expect(redis._expires['broadcast:watchdog:fail-count:round-1']).toBeGreaterThan(0);
    expect(logger._lines.find((l) => l.includes('stuck — source unreachable'))).toBeTruthy();
  });

  it('лиц 5xx — 3 раза подряд → round помечается failed', async () => {
    // Эмулируем: через redis.incr возвращаем 3 на третий вызов.
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2; // уже 2 fail'а
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 503 }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('closed-failed');
    expect((prisma as unknown as { _updates: { id: string; data: { status: string } }[] })._updates).toEqual([
      { id: 'round-1', data: { status: 'failed' } },
    ]);
    expect(redis._dels).toContain('broadcast:watchdog:fail-count:round-1');
    expect(logger._lines.find((l) => l.includes('closed (status=failed'))).toBeTruthy();
  });

  it('timeout / network error → unreachable, fail-counter инкрементится', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 0, throws: new Error('TimeoutError') }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect(redis._counts['broadcast:watchdog:fail-count:round-1']).toBe(1);
    expect(logger._lines.find((l) => l.includes('lichess fetch error'))).toBeTruthy();
  });

  it('429 от Lichess → unreachable (не закрываем, ждём rate-limit reset)', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 429 }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect(r.outcomes[0].reason).toMatch(/rate limit/);
    expect((prisma as unknown as { _updates: unknown[] })._updates).toHaveLength(0);
  });

  it('пустой ответ от Lichess (200, body пустой) → live (раунд есть, партий нет)', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 200, body: '' }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-live');
    expect((prisma as unknown as { _updates: unknown[] })._updates).toHaveLength(0);
  });

  it('несколько round\'ов в одном тике обрабатываются независимо', async () => {
    const rounds = [
      fakeRound({ id: 'r-1', lichess_round_id: 'lr1' }),
      fakeRound({ id: 'r-2', lichess_round_id: 'lr2' }),
      fakeRound({ id: 'r-3', lichess_round_id: 'lr3' }),
    ];
    const prisma = makePrisma(rounds);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([
      { status: 404 }, // r-1 → finished
      { status: 200, body: PGN_HAS_ONGOING }, // r-2 → live
      { status: 503 }, // r-3 → unreachable (1 fail)
    ]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.scanned).toBe(3);
    expect(r.outcomes.map((o) => o.outcome)).toEqual([
      'closed-finished',
      'stuck-live',
      'stuck-unreachable',
    ]);
    expect((prisma as unknown as { _updates: { id: string }[] })._updates.map((u) => u.id)).toEqual(['r-1']);
  });

  it('пустой кандидатский список → ничего не делаем, log пустой outcome', async () => {
    const prisma = makePrisma([]);
    const redis = makeRedis();
    const logger = makeLogger();
    const fetchFn = mockFetch([]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.scanned).toBe(0);
    expect(r.outcomes).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((prisma as unknown as { _updates: unknown[] })._updates).toHaveLength(0);
  });

  it('параметр staleThresholdMin прокидывается в SQL', async () => {
    const prisma = makePrisma([]);
    const redis = makeRedis();
    const logger = makeLogger();

    await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: mockFetch([]) as unknown as typeof fetch,
      staleThresholdMin: 45,
    });

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('make_interval(mins => $1::int)'),
      45,
    );
  });

  // KS-2591: проверяем, что при skipped lock тик пишет лог
  // (ранее был silent return — нельзя было отличить «не запущен»
  // от «лок держит другая реплика»).
  it('tickSafe: lock=false → пишет лог о skipped tick и не идёт дальше', async () => {
    const setSpy = jest.fn(async () => null); // NX returns null when key exists
    const fakeRedis = { set: setSpy } as unknown as RedisService;
    const fakePrisma = {
      $queryRawUnsafe: jest.fn(),
    } as unknown as PrismaService;

    const service = new BroadcastWatchdogService(fakePrisma, fakeRedis);
    const logSpy = jest
      .spyOn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service as any).logger as { log: (m: string) => void },
        'log',
      )
      .mockImplementation(() => {});

    // приватный метод — вызываем через any-cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).tickSafe();

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[broadcast-watchdog] tick skipped (lock held by other replica)',
    );
    // lock не получен — основной путь не запускался, $queryRawUnsafe не дёргали
    expect(fakePrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  // KS-3332: tour-API guard — PGN-stream Lichess может быть 429-throttled
  // для конкретного round'а, при этом сам round в tour-API ongoing.
  // Watchdog не должен переводить такие round'ы в failed.
  it('KS-3332: PGN unreachable 3× НО tour-API говорит ongoing → НЕ closed-failed', async () => {
    const prisma = makePrisma([fakeRound()], {
      'b-1': { lichessId: 'tour-1' },
    });
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2; // следующий incr = 3
    const logger = makeLogger();
    // 1-й fetch — PGN endpoint (429), 2-й — tour-API (200 + ongoing для round).
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 })) // PGN throttled
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tour: { id: 'tour-1' },
            rounds: [
              { id: 'lichess-r1', ongoing: true },
              { id: 'lichess-r2', finished: true },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // Round НЕ закрыт в failed.
    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect(r.outcomes[0].reason).toMatch(/tour-API says ongoing/);
    expect(
      (prisma as unknown as { _updates: unknown[] })._updates,
    ).toHaveLength(0);
    expect(
      logger._lines.find((l) =>
        l.includes('SKIP failed-transition'),
      ),
    ).toBeTruthy();
  });

  it('KS-3332: PGN unreachable 3× + tour-API не говорит ongoing → обычный closed-failed', async () => {
    const prisma = makePrisma([fakeRound()], {
      'b-1': { lichessId: 'tour-1' },
    });
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2;
    const logger = makeLogger();
    // tour-API отвечает что round finished (или его нет) — guard не блокирует.
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tour: { id: 'tour-1' },
            rounds: [{ id: 'lichess-r1', finished: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('closed-failed');
    expect(
      (prisma as unknown as { _updates: { data: { status: string } }[] })
        ._updates[0].data.status,
    ).toBe('failed');
  });

  it('KS-3478: PGN unreachable 3× + tour-API сам HTTP-non-OK → НЕ закрываем (нет подтверждения)', async () => {
    // KS-3478: пересмотр KS-3332. Когда tour-API guard сам fetch-failed
    // (HTTP 5xx, network/DNS/TLS), у нас нет подтверждения от Lichess
    // о статусе round'а. Отказ может быть в нашем egress (как в KS-3477).
    // Безопаснее НЕ закрывать — оставить ongoing/whatever, дождаться
    // восстановления связи или решающего ответа.
    const prisma = makePrisma([fakeRound()], {
      'b-1': { lichessId: 'tour-1' },
    });
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2;
    const logger = makeLogger();
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 })) // PGN
      .mockResolvedValueOnce(new Response('', { status: 503 })); // tour-API

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect(r.outcomes[0].reason).toMatch(/tour-API guard fetch-failed/);
    expect(
      (prisma as unknown as { _updates: unknown[] })._updates,
    ).toHaveLength(0);
    expect(
      logger._lines.find((l) => l.includes('SKIP failed-transition')),
    ).toBeTruthy();
  });

  it('KS-3478: PGN unreachable 3× + tour-API network throw → НЕ закрываем', async () => {
    // catch внутри checkRoundStatusInTour → 'fetch-failed'.
    const prisma = makePrisma([fakeRound()], {
      'b-1': { lichessId: 'tour-1' },
    });
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 2;
    const logger = makeLogger();
    const fetchFn = jest
      .fn()
      // PGN call (source-probe) — отказ.
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      // tour-API call — настоящий network throw.
      .mockRejectedValueOnce(
        Object.assign(new Error('fetch failed'), { cause: undefined }),
      );

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(r.outcomes[0].outcome).toBe('stuck-unreachable');
    expect(
      (prisma as unknown as { _updates: unknown[] })._updates,
    ).toHaveLength(0);
  });

  it('параметр unreachableFailThreshold перебивает дефолт', async () => {
    const prisma = makePrisma([fakeRound()]);
    const redis = makeRedis();
    redis._counts['broadcast:watchdog:fail-count:round-1'] = 1; // следующий incr = 2
    const logger = makeLogger();
    const fetchFn = mockFetch([{ status: 503 }]);

    const r = await runWatchdogTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      unreachableFailThreshold: 2, // на втором fail'е уже закрываем
    });

    expect(r.outcomes[0].outcome).toBe('closed-failed');
    expect((prisma as unknown as { _updates: { data: { status: string } }[] })._updates[0].data.status).toBe('failed');
  });
});
