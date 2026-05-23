/**
 * KS-3231. Тесты cron-метрики «партий в раунде меньше чем у lichess».
 *
 * Покрываемые acceptance-сценарии:
 *   1) у нас 5 партий, у lichess 5 → mismatch=0, telegram НЕ вызывается;
 *   2) у нас 1, у lichess 5 → mismatch=1, telegram вызывается с верным
 *      payload (Romania-сценарий KS-3229);
 *   3) повторный tick через 5 минут с тем же mismatch → telegram НЕ
 *      вызывается (Redis-дедуп держит ключ 1 час);
 *   4) lichess недоступен (5xx / timeout) → раунд тихо скипается, без
 *      ложного mismatch;
 *   5) telegram-функция возвращает false → лог warn, дедуп НЕ
 *      освобождается (избегаем спама на flapping);
 *   6) формат telegram-сообщения корректно агрегирует по broadcast'у.
 *
 * Покрываем чистую функцию `runGameCountCheckTick` через подменяемые
 * `prisma`/`redis`/`fetchFn`/`telegramFn` — без поднятия NestJS.
 */
import {
  runGameCountCheckTick,
  formatTelegramMessage,
} from './broadcast-game-count-metric.service';
import type {
  MetricCheckPrisma,
  MetricCheckRedis,
  RoundMismatch,
} from './broadcast-game-count-metric.service';

interface FakeRow {
  broadcast_id: string;
  broadcast_title: string;
  lichess_broadcast_id: string;
  round_id: string;
  lichess_round_id: string;
  round_name: string;
  our_count: bigint;
}

function makePrisma(rows: FakeRow[]) {
  return {
    $queryRawUnsafe: jest.fn(async () => rows),
  } as unknown as MetricCheckPrisma;
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    set: jest.fn(
      async (
        key: string,
        value: string,
        _mode: 'EX',
        _ttl: number,
        nx?: 'NX',
      ): Promise<'OK' | null> => {
        if (nx === 'NX' && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
    ),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
  } as unknown as MetricCheckRedis & { _store: Map<string, string> };
}

function makeLogger() {
  const lines: string[] = [];
  return {
    _lines: lines,
    log: (m: string) => lines.push(`log: ${m}`),
    warn: (m: string) => lines.push(`warn: ${m}`),
    error: (m: string) => lines.push(`error: ${m}`),
  };
}

function makePgnResponse(gameCount: number): Response {
  const headers = Array.from({ length: gameCount }, (_, i) => {
    return [
      `[Event "Test"]`,
      `[White "Player${i}"]`,
      `[Black "Opponent${i}"]`,
      `[Result "*"]`,
      ``,
      `1. e4 *`,
    ].join('\n');
  }).join('\n\n');
  return new Response(headers, {
    status: 200,
    headers: { 'content-type': 'application/x-chess-pgn' },
  });
}

function makeRow(
  overrides: Partial<FakeRow> & {
    roundId: string;
    lichessRoundId: string;
    ourCount: number;
  },
): FakeRow {
  return {
    broadcast_id: overrides.broadcast_id ?? 'b-romania',
    broadcast_title: overrides.broadcast_title ?? 'GCT Romania 2026',
    lichess_broadcast_id: overrides.lichess_broadcast_id ?? 'p3ctK4xS',
    round_id: overrides.roundId,
    lichess_round_id: overrides.lichessRoundId,
    round_name: overrides.round_name ?? 'Round 1',
    our_count: BigInt(overrides.ourCount),
  };
}

describe('KS-3231 runGameCountCheckTick', () => {
  it('mismatch=0 когда наш count >= lichess', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      sleepFn: async () => {},
    });
    expect(r.mismatches).toEqual([]);
    expect(r.newAlerts).toEqual([]);
    expect(telegramFn).not.toHaveBeenCalled();
  });

  it('KS-3264: mismatch=1 + успешный auto-resync → telegram НЕ вызывается', async () => {
    const prisma = makePrisma([
      makeRow({
        roundId: 'r1',
        lichessRoundId: 'Vos7UzKR',
        ourCount: 1,
        round_name: 'Round 1',
      }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    // auto-resync поднял gamesAfter до 5 (=lichess), значит mismatch
    // закрыт — telegram молчит.
    const autoResyncFn = jest.fn(async () => ({
      fetched: true,
      gamesBefore: 1,
      gamesAfter: 5,
    }));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.mismatches).toHaveLength(1);
    expect(autoResyncFn).toHaveBeenCalledWith('Vos7UzKR');
    expect(r.autoResyncStats.attempted).toBe(1);
    expect(r.autoResyncStats.succeeded).toBe(1);
    expect(r.autoResyncStats.errors).toBe(0);
    expect(r.telegramSent).toBe(false);
    expect(telegramFn).not.toHaveBeenCalled();
  });

  it('KS-3264: повторный tick с тем же mismatch → cooldown скипает auto-resync', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: true,
      gamesBefore: 1,
      gamesAfter: 5,
    }));

    const r1 = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r1.autoResyncStats.attempted).toBe(1);
    expect(autoResyncFn).toHaveBeenCalledTimes(1);

    // Второй tick: cooldown держится, auto-resync пропускается.
    const r2 = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r2.mismatches).toHaveLength(1);
    expect(r2.autoResyncStats.attempted).toBe(0);
    expect(r2.autoResyncStats.skippedByCooldown).toBe(1);
    expect(autoResyncFn).toHaveBeenCalledTimes(1); // не вызвался второй раз
    expect(telegramFn).not.toHaveBeenCalled();
  });

  it('KS-3264: auto-resync вернул fetched=false → telegram-ошибка', async () => {
    // Lichess 429 backoff в SyncService → forceResyncRound возвращает
    // fetched=false. Это error-сценарий, идёт в telegram.
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    }));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.autoResyncStats.errors).toBe(1);
    expect(r.telegramSent).toBe(true);
    const [msg] = telegramFn.mock.calls[0] as [string];
    expect(msg).toContain('Auto-resync failures');
    expect(msg).toContain('Errors');
    expect(msg).toContain('fetched=false');
  });

  it('KS-3264: auto-resync прошёл (fetched=true) но gamesAfter всё ещё < lichess → persistent telegram', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: true,
      gamesBefore: 1,
      gamesAfter: 3, // < lichess=5
    }));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.autoResyncStats.persistentMismatches).toBe(1);
    expect(r.telegramSent).toBe(true);
    const [msg] = telegramFn.mock.calls[0] as [string];
    expect(msg).toContain('Persistent mismatch');
    expect(msg).toContain('1 → *3*');
    expect(msg).toContain('lichess=*5*');
  });

  it('KS-3264: auto-resync кинул exception → error telegram', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => {
      throw new Error('boom');
    });
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.autoResyncStats.errors).toBe(1);
    expect(r.telegramSent).toBe(true);
    const [msg] = telegramFn.mock.calls[0] as [string];
    expect(msg).toContain('exception: boom');
  });

  it('lichess HTTP 503 — раунд тихо скипается, без mismatch', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => new Response('', { status: 503 }));
    const telegramFn = jest.fn(async () => true);
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      sleepFn: async () => {},
    });
    expect(r.mismatches).toEqual([]);
    expect(telegramFn).not.toHaveBeenCalled();
  });

  it('lichess 404 → count=0, у нас тоже 0 → не mismatch', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 0 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => new Response('', { status: 404 }));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
    });
    expect(r.mismatches).toEqual([]);
  });

  it('KS-3264: telegram упал → cooldown НЕ освобождается (anti-spam)', async () => {
    // KS-3264: cooldown ключ держится 1 час даже если telegram failed.
    // Иначе при flapping telegram мы бы спамили auto-resync и Lichess.
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Vos7UzKR', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => false);
    const autoResyncFn = jest.fn(async () => ({
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    }));
    const logger = makeLogger();
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.telegramSent).toBe(false);
    // Cooldown-ключ остался (auto-resync уже attempted, второй tick его пропустит).
    expect(
      [...redis._store.keys()].some((k) =>
        k.startsWith('broadcast:auto-resync:cooldown:'),
      ),
    ).toBe(true);
    expect(logger._lines.some((l) => l.includes('telegram send failed'))).toBe(
      true,
    );
  });

  it('KS-3264: 2 failed auto-resync разных broadcast → одно telegram-сообщение со списком', async () => {
    const prisma = makePrisma([
      makeRow({
        roundId: 'r1',
        lichessRoundId: 'Vos7UzKR',
        ourCount: 1,
        round_name: 'Round 1',
      }),
      makeRow({
        roundId: 'r2',
        lichessRoundId: 'FDb3eO7v',
        ourCount: 1,
        round_name: 'Round 2',
      }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    }));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r.autoResyncStats.errors).toBe(2);
    expect(telegramFn).toHaveBeenCalledTimes(1); // одно сообщение
    const [msg] = telegramFn.mock.calls[0] as [string];
    // escapeMd-формат: «*Auto-resync failures* (2)» — текст содержит и
    // emoji и количество, проверяем по подстрокам без зависимости от
    // расположения markdown-звёздочек.
    expect(msg).toContain('Auto-resync failures');
    expect(msg).toContain('(2)');
    expect(msg).toContain('Vos7UzKR');
    expect(msg).toContain('FDb3eO7v');
  });

  it('rate-limit gap между Lichess-запросами вызывает sleepFn', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'R1', ourCount: 5 }),
      makeRow({ roundId: 'r2', lichessRoundId: 'R2', ourCount: 5 }),
      makeRow({ roundId: 'r3', lichessRoundId: 'R3', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const sleepFn = jest.fn(async () => {});
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    // 3 раунда, sleep между ними — 2 раза.
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1500);
  });
});

describe('KS-3231 formatTelegramMessage', () => {
  it('один mismatch — оборачивает в Markdown с emoji и parse_mode-safe', () => {
    const alerts: RoundMismatch[] = [
      {
        broadcastId: 'b1',
        broadcastTitle: 'GCT Romania 2026',
        lichessBroadcastId: 'p3ctK4xS',
        roundId: 'r1',
        lichessRoundId: 'Vos7UzKR',
        roundName: 'Round 1',
        ourCount: 1,
        lichessCount: 5,
      },
    ];
    const msg = formatTelegramMessage(alerts);
    expect(msg).toContain('⚠️');
    expect(msg).toContain('GCT Romania 2026');
    expect(msg).toContain('p3ctK4xS');
    expect(msg).toContain('Round 1');
    expect(msg).toContain('*1*');
    expect(msg).toContain('*5*');
  });

  it('экранирует Markdown-спецсимволы в названии', () => {
    const alerts: RoundMismatch[] = [
      {
        broadcastId: 'b1',
        broadcastTitle: 'Test *bold* _italic_ [link]',
        lichessBroadcastId: 'X',
        roundId: 'r1',
        lichessRoundId: 'L1',
        roundName: 'Round `code`',
        ourCount: 0,
        lichessCount: 1,
      },
    ];
    const msg = formatTelegramMessage(alerts);
    // Спецсимволы из заголовка broadcast — экранированы.
    expect(msg).toContain('Test \\*bold\\* \\_italic\\_ \\[link\\]');
    expect(msg).toContain('Round \\`code\\`');
  });
});
