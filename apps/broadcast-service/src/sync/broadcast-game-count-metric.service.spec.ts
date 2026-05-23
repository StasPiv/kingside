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
    // KS-3265: INCR/EXPIRE/DEL для эскалирующего cooldown'а.
    incr: jest.fn(async (k: string) => {
      const cur = Number.parseInt(store.get(k) ?? '0', 10);
      const next = cur + 1;
      store.set(k, String(next));
      return next;
    }),
    expire: jest.fn(async (_k: string, _ttl: number) => 1),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
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

  it('KS-3264/3265: после failure повторный tick — cooldown скипает auto-resync (до истечения TTL)', async () => {
    // При успехе KS-3265 reset'ит cooldown (серия закрыта). Чтобы
    // протестировать «cooldown держит между tick'ами», берём failure-
    // сценарий — тогда cooldown EXPIRE'ит на ladder[0]=3600s и второй
    // tick его NX не пробьёт.
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

    // Второй tick: cooldown держится (EXPIRE на ladder[0]=3600s),
    // NX не приобретает, auto-resync пропускается.
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

  it('KS-3265: persistent fetched=false — 1-я неудача telegram, 2-я silenced (cooldown сброшен между tick\'ами)', async () => {
    // Эмулируем кейс «Shri Dhanpat Rai» — Lichess стабильно отдаёт
    // PGN без партий, force-resync возвращает fetched=false на каждом
    // tick'е. До KS-3265 пользователь получал tg каждый час.
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'PersistRid', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    }));

    // Tick #1 — первая failure, telegram идёт.
    const r1 = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r1.autoResyncStats.errors).toBe(1);
    expect(r1.autoResyncStats.silencedByRetryLimit).toBe(0);
    expect(r1.telegramSent).toBe(true);
    expect(telegramFn).toHaveBeenCalledTimes(1);

    // Эмулируем «cooldown истёк» — удаляем cooldown-key (но failures-
    // counter остаётся!). При наследующем tick'е cooldown NX снова
    // приобретётся, auto-resync дёрнется, упадёт, counter INCR'нется
    // до 2 → telegram silenced.
    expect(redis._store.has('broadcast:auto-resync:cooldown:PersistRid')).toBe(true);
    redis._store.delete('broadcast:auto-resync:cooldown:PersistRid');

    const r2 = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn,
      autoResyncFn,
      sleepFn: async () => {},
    });
    expect(r2.autoResyncStats.errors).toBe(0); // только первая ошибка counted в errors
    expect(r2.autoResyncStats.silencedByRetryLimit).toBe(1);
    expect(r2.telegramSent).toBe(false); // silenced
    expect(telegramFn).toHaveBeenCalledTimes(1); // НЕ вырос
    // Counter дошёл до 2.
    expect(redis._store.get('broadcast:auto-resync:failures:PersistRid')).toBe('2');
  });

  it('KS-3265: успех после серии неудач — cooldown сброшен, counter живёт в grace (default 600s)', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Recover', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    // Сначала failure (для INCR counter'а до 1).
    let autoResyncReturn: { fetched: boolean; gamesBefore: number; gamesAfter: number } = {
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    };
    const autoResyncFn = jest.fn(async () => autoResyncReturn);

    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
    });
    expect(redis._store.get('broadcast:auto-resync:failures:Recover')).toBe('1');

    // Симулируем cooldown expiry + успешный resync на следующем tick'е.
    redis._store.delete('broadcast:auto-resync:cooldown:Recover');
    autoResyncReturn = { fetched: true, gamesBefore: 1, gamesAfter: 5 };
    (redis.expire as jest.Mock).mockClear();

    const r2 = await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
    });
    expect(r2.autoResyncStats.succeeded).toBe(1);
    // Cooldown DEL'ится (mock map очищает) — discard cooldown.
    expect(redis._store.has('broadcast:auto-resync:cooldown:Recover')).toBe(false);
    // KS-3265 ext: failures-counter НЕ DEL'ится, а EXPIRE'ится на 600s.
    // Mock map не expire'ит ключи — counter всё ещё в store со значением '1'.
    expect(redis._store.get('broadcast:auto-resync:failures:Recover')).toBe('1');
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Recover',
      600,
    );
  });

  it('KS-3265 ext: flap «success → fail в grace-окне» — silenced, без telegram', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Flap', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    // Tick 1: failure (INCR counter до 1, telegram уходит).
    let autoResyncReturn: { fetched: boolean; gamesBefore: number; gamesAfter: number } = {
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    };
    const autoResyncFn = jest.fn(async () => autoResyncReturn);

    const r1 = await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
    });
    expect(r1.telegramSent).toBe(true);
    expect(r1.autoResyncStats.errors).toBe(1);
    expect(r1.autoResyncStats.silencedByRetryLimit).toBe(0);

    // Tick 2: cooldown снят, success (counter получает grace TTL).
    redis._store.delete('broadcast:auto-resync:cooldown:Flap');
    autoResyncReturn = { fetched: true, gamesBefore: 1, gamesAfter: 5 };
    telegramFn.mockClear();

    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
    });
    // Counter живёт в grace (mock не expire'ит — но реальный Redis
    // EXPIRE'нет, значение '1' остаётся).
    expect(redis._store.get('broadcast:auto-resync:failures:Flap')).toBe('1');

    // Tick 3: ВНУТРИ grace'а — новая failure. INCR даёт 2 → silenced.
    redis._store.delete('broadcast:auto-resync:cooldown:Flap');
    autoResyncReturn = { fetched: false, gamesBefore: 5, gamesAfter: 5 };
    telegramFn.mockClear();

    const r3 = await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
    });

    expect(redis._store.get('broadcast:auto-resync:failures:Flap')).toBe('2');
    expect(r3.telegramSent).toBe(false); // <<< grace-окно подавило flap-телеграмму
    expect(r3.autoResyncStats.silencedByRetryLimit).toBe(1);
    expect(r3.autoResyncStats.errors).toBe(0);
    expect(telegramFn).not.toHaveBeenCalled();
  });

  it('KS-3265 kill-switch: telegramFailuresEnabled=false — telegram не вызывается, auto-resync работает', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'KillSwitch', ourCount: 1 }),
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
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      telegramFailuresEnabled: false,
    });

    // auto-resync был вызван (механизм работает).
    expect(autoResyncFn).toHaveBeenCalledWith('KillSwitch');
    // failure зарегистрирован в stats (счётчики не подавлены).
    expect(r.autoResyncStats.attempted).toBe(1);
    expect(r.autoResyncStats.errors).toBe(1);
    // НО telegram НЕ отправлен.
    expect(telegramFn).not.toHaveBeenCalled();
    expect(r.telegramSent).toBe(false);
  });

  it('KS-3265 kill-switch: telegramFailuresEnabled=true (default) — telegram отправляется', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'TelegramOn', ourCount: 1 }),
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
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      // telegramFailuresEnabled опущен → default true
    });

    expect(telegramFn).toHaveBeenCalledTimes(1);
    expect(r.telegramSent).toBe(true);
  });

  it('KS-3265 ext: successGraceSec env-override применяется', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'CustomGrace', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    let autoResyncReturn: { fetched: boolean; gamesBefore: number; gamesAfter: number } = {
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    };
    const autoResyncFn = jest.fn(async () => autoResyncReturn);
    // Tick 1 → failure.
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      successGraceSec: 1800,
    });
    redis._store.delete('broadcast:auto-resync:cooldown:CustomGrace');
    autoResyncReturn = { fetched: true, gamesBefore: 1, gamesAfter: 5 };
    (redis.expire as jest.Mock).mockClear();

    // Tick 2 → success, ожидаем EXPIRE(failuresKey, 1800).
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      successGraceSec: 1800,
    });
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:CustomGrace',
      1800,
    );
  });

  it('KS-3265: ladder применяется по failures-counter (1→3600, 2→10800, 3→43200, 4+→86400)', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Ladder', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const telegramFn = jest.fn(async () => true);
    const autoResyncFn = jest.fn(async () => ({
      fetched: false,
      gamesBefore: 1,
      gamesAfter: 1,
    }));
    const ladder = [60, 180, 600, 3600]; // компактный ladder для теста

    // Tick 1 → failures=1, ttl=60.
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      failureCooldownLadderSec: ladder,
    });
    // expire был вызван с 60 на обоих ключах (failures + cooldown).
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Ladder', 60,
    );
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:cooldown:Ladder', 60,
    );

    // Очищаем cooldown между tick'ами, чтобы NX снова acquire'ился.
    (redis.expire as jest.Mock).mockClear();
    redis._store.delete('broadcast:auto-resync:cooldown:Ladder');
    // Tick 2 → failures=2, ttl=180.
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      failureCooldownLadderSec: ladder,
    });
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Ladder', 180,
    );

    (redis.expire as jest.Mock).mockClear();
    redis._store.delete('broadcast:auto-resync:cooldown:Ladder');
    // Tick 3 → failures=3, ttl=600.
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      failureCooldownLadderSec: ladder,
    });
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Ladder', 600,
    );

    (redis.expire as jest.Mock).mockClear();
    redis._store.delete('broadcast:auto-resync:cooldown:Ladder');
    // Tick 4 → failures=4, ttl=3600 (последний из ladder).
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      failureCooldownLadderSec: ladder,
    });
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Ladder', 3600,
    );

    (redis.expire as jest.Mock).mockClear();
    redis._store.delete('broadcast:auto-resync:cooldown:Ladder');
    // Tick 5 → failures=5, ttl=3600 (overflow → последний).
    await runGameCountCheckTick({
      prisma, redis, logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      telegramFn, autoResyncFn, sleepFn: async () => {},
      failureCooldownLadderSec: ladder,
    });
    expect(redis.expire).toHaveBeenCalledWith(
      'broadcast:auto-resync:failures:Ladder', 3600,
    );
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
