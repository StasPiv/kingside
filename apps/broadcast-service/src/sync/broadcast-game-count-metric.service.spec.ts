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

  it('KS-3253: rate-limit gap теперь между ЧАНКАМИ параллельных fetch (500мс)', async () => {
    // 7 раундов при concurrency=3 → 3 чанка (3+3+1), между чанками
    // 2 sleep'а по LICHESS_INTER_CHUNK_DELAY_MS = 500мс. Внутри
    // чанка fetch'и параллельны — sleep между ними не вызывается.
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'R1', ourCount: 5 }),
      makeRow({ roundId: 'r2', lichessRoundId: 'R2', ourCount: 5 }),
      makeRow({ roundId: 'r3', lichessRoundId: 'R3', ourCount: 5 }),
      makeRow({ roundId: 'r4', lichessRoundId: 'R4', ourCount: 5 }),
      makeRow({ roundId: 'r5', lichessRoundId: 'R5', ourCount: 5 }),
      makeRow({ roundId: 'r6', lichessRoundId: 'R6', ourCount: 5 }),
      makeRow({ roundId: 'r7', lichessRoundId: 'R7', ourCount: 5 }),
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
    // 3 чанка → 2 паузы между чанками; других sleep'ов нет (все
    // запросы успешны, retry/backoff не задействован).
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(500);
  });

  it('KS-3253: чанк ≤ concurrency — sleep между чанками не вызывается', async () => {
    // 3 раунда умещаются в один чанк (concurrency=3) → 0 пауз.
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
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('KS-3253: fetch-вызовы внутри чанка реально стартуют параллельно', async () => {
    // Засекаем concurrent in-flight через counter: при concurrency=3
    // максимальное наблюдаемое значение должно быть 3 (на 6 раундах).
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'P1', ourCount: 5 }),
      makeRow({ roundId: 'r2', lichessRoundId: 'P2', ourCount: 5 }),
      makeRow({ roundId: 'r3', lichessRoundId: 'P3', ourCount: 5 }),
      makeRow({ roundId: 'r4', lichessRoundId: 'P4', ourCount: 5 }),
      makeRow({ roundId: 'r5', lichessRoundId: 'P5', ourCount: 5 }),
      makeRow({ roundId: 'r6', lichessRoundId: 'P6', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = jest.fn(async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // микро-await чтобы дать planner'у время на параллельный запуск.
      await new Promise<void>((r) => setImmediate(r));
      inFlight--;
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    // Concurrency=3 → внутри чанка 3 fetch'а должны быть in-flight
    // одновременно.
    expect(maxInFlight).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  // ─── KS-3479: retry + early-exit при caсkade'е fail'ов ─────────────

  it('KS-3479: 429 с Retry-After → ретрай через указанное время, успех на 2-й попытке', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X429-1', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '3' },
        });
      }
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
      autoResyncFn: async () => ({
        fetched: true,
        gamesBefore: 1,
        gamesAfter: 5,
      }),
    });
    // Дополнительный sleep на ретрай — 3000ms из Retry-After.
    expect(sleepFn).toHaveBeenCalledWith(3000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.mismatches).toHaveLength(1);
    expect(r.autoResyncStats.attempted).toBe(1);
  });

  it('KS-3479: 5xx → 2s backoff и ретрай, успех на 2-й', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X5xx-1', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) {
        return new Response('server error', { status: 503 });
      }
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(sleepFn).toHaveBeenCalledWith(2000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.mismatches).toHaveLength(0);
  });

  it('KS-3479: network throw → 2s backoff и ретрай, итоговый успех', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Xnet-1', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) {
        throw new Error('ECONNREFUSED');
      }
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(sleepFn).toHaveBeenCalledWith(2000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.mismatches).toHaveLength(0);
  });

  it('KS-3479: persistent 5xx после ретрая → null (как раньше), tick продолжается', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'Xerr-1', ourCount: 1 }),
      makeRow({ roundId: 'r2', lichessRoundId: 'Xerr-2', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('Xerr-1')) {
        return new Response('server error', { status: 503 });
      }
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    // r1: 2 попытки (originalplus retry) → null. r2: успех.
    // mismatches.length=0 (r1 не учтён из-за null, r2 our>=lichess).
    expect(r.mismatches).toEqual([]);
    // r1 был вызван дважды, r2 — один раз.
    const r1Calls = fetchFn.mock.calls.filter((c) =>
      String(c[0]).includes('Xerr-1'),
    ).length;
    expect(r1Calls).toBe(2);
  });

  it('KS-3479/KS-3253: подряд null-результаты → ранний break (на границе чанка)', async () => {
    // 9 раундов, все 503. С concurrency=3 break срабатывает в конце
    // второго чанка (consecutiveNulls=6 >= 5). 3-й чанк не стартует.
    // Внутри чанка все 3 fetch'а + retry уходят параллельно, поэтому
    // 503-retry даёт по 2 fetch на каждый раунд → 6 раундов × 2 = 12
    // fetch-вызовов. 7-й..9-й раунды не вызываются.
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'F1', ourCount: 1 }),
      makeRow({ roundId: 'r2', lichessRoundId: 'F2', ourCount: 1 }),
      makeRow({ roundId: 'r3', lichessRoundId: 'F3', ourCount: 1 }),
      makeRow({ roundId: 'r4', lichessRoundId: 'F4', ourCount: 1 }),
      makeRow({ roundId: 'r5', lichessRoundId: 'F5', ourCount: 1 }),
      makeRow({ roundId: 'r6', lichessRoundId: 'F6', ourCount: 1 }),
      makeRow({ roundId: 'r7', lichessRoundId: 'X7', ourCount: 1 }),
      makeRow({ roundId: 'r8', lichessRoundId: 'X8', ourCount: 1 }),
      makeRow({ roundId: 'r9', lichessRoundId: 'X9', ourCount: 1 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => {
      return new Response('', { status: 503 });
    });
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(12);
    expect(r.mismatches).toEqual([]);
    // 7-й..9-й раунды не были запрошены.
    expect(
      fetchFn.mock.calls.some((c) => /X[789]/.test(String(c[0]))),
    ).toBe(false);
  });

  it('KS-3479: 4xx (не 429) → НЕ ретраим, идём дальше', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X400-1', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => new Response('', { status: 400 }));
    const sleepFn = jest.fn(async () => {});
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // 400 → backoff не было; 1.5s rate-limit между раундами тоже не
    // было (один раунд) — sleep вообще не вызывался.
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('KS-3479: 404 → 0 без ретраев (round удалён, не ошибка)', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X404-1', ourCount: 0 }),
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => new Response('', { status: 404 }));
    const sleepFn = jest.fn(async () => {});
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.mismatches).toEqual([]);
  });

  it('KS-3479: 429 без Retry-After → дефолтный min-wait (1s)', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X429-2', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) return new Response('', { status: 429 });
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('KS-3479: 429 с очень большим Retry-After → clamp до max-wait (30s)', async () => {
    const prisma = makePrisma([
      makeRow({ roundId: 'r1', lichessRoundId: 'X429-3', ourCount: 5 }),
    ]);
    const redis = makeRedis();
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '600' }, // 10 минут — слишком много
        });
      }
      return makePgnResponse(5);
    });
    const sleepFn = jest.fn(async () => {});
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
    });
    expect(sleepFn).toHaveBeenCalledWith(30_000);
  });

  // ─── KS-3257: round-robin slow-scan хвоста ─────────────────────

  /**
   * Spied Prisma — каждый вызов `$queryRawUnsafe` возвращает отдельный
   * результат из очереди `responses`. Используется для slow-scan, где
   * один tick делает ДВА SELECT'а: hot + cold. Аргументы SQL
   * сохраняются в `calls` для проверки OFFSET/LIMIT.
   */
  function makePrismaQueue(responses: FakeRow[][]) {
    let i = 0;
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const mock = jest.fn(async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      const r = responses[Math.min(i, responses.length - 1)] ?? [];
      i++;
      return r;
    });
    return {
      _calls: calls,
      $queryRawUnsafe: mock,
    } as unknown as MetricCheckPrisma & {
      _calls: Array<{ sql: string; params: unknown[] }>;
    };
  }

  it('KS-3257: slow-scan выключен (default) → cold-SELECT не выполняется', async () => {
    const prisma = makePrismaQueue([
      [makeRow({ roundId: 'r1', lichessRoundId: 'R1', ourCount: 5 })],
    ]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
    });
    // Один SELECT (hot only). slowScanBatchSize не задан → default 0.
    expect(prisma._calls).toHaveLength(1);
    expect(r.coldOffset).toBeNull();
    expect(r.coldRounds).toBe(0);
  });

  it('KS-3257: slow-scan включён, Redis пуст → начало с offset=0, advance после tick', async () => {
    const hotRow = makeRow({
      roundId: 'r-hot',
      lichessRoundId: 'HOT',
      ourCount: 5,
    });
    const coldRow = makeRow({
      roundId: 'r-cold',
      lichessRoundId: 'COLD',
      ourCount: 5,
      broadcast_id: 'b-cold',
    });
    const prisma = makePrismaQueue([[hotRow], [coldRow]]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
      maxBroadcasts: 50,
      slowScanBatchSize: 25,
      slowScanWrapAt: 100,
    });
    // Два SELECT'а: hot + cold.
    expect(prisma._calls).toHaveLength(2);
    expect(r.coldOffset).toBe(0); // первый запуск
    expect(r.coldRounds).toBe(1);
    expect(r.scannedRounds).toBe(2);
    // Cold-SELECT параметры: OFFSET = (maxBroadcasts + offset) * 15 = 750,
    // LIMIT = batch * 15 = 375.
    expect(prisma._calls[1].params).toEqual([750, 375]);
    // Redis-offset обновлён: было 0, advance на batch=25 → 25.
    expect(redis._store.get('broadcast:metric:slow-scan:offset')).toBe('25');
    // Cold row тоже прошёл fetch — проверяем что mismatch-loop его видел.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('KS-3257: slow-scan, Redis уже содержит offset → продвижение по нему', async () => {
    const prisma = makePrismaQueue([[], []]);
    const redis = makeRedis();
    redis._store.set('broadcast:metric:slow-scan:offset', '40');
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
      maxBroadcasts: 50,
      slowScanBatchSize: 25,
      slowScanWrapAt: 100,
    });
    expect(r.coldOffset).toBe(40);
    expect(r.coldRounds).toBe(0);
    // OFFSET = (50 + 40) * 15 = 1350.
    expect(prisma._calls[1].params).toEqual([1350, 375]);
    // 0 cold-строк → reachedEnd, wrap на 0.
    expect(redis._store.get('broadcast:metric:slow-scan:offset')).toBe('0');
  });

  it('KS-3257: advanced >= wrapAt → wrap на 0', async () => {
    const coldRow = makeRow({
      roundId: 'r-tail',
      lichessRoundId: 'TAIL',
      ourCount: 5,
    });
    const prisma = makePrismaQueue([[], [coldRow]]);
    const redis = makeRedis();
    redis._store.set('broadcast:metric:slow-scan:offset', '80');
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
      maxBroadcasts: 50,
      slowScanBatchSize: 25,
      slowScanWrapAt: 100, // 80 + 25 = 105 >= 100 → wrap
    });
    expect(redis._store.get('broadcast:metric:slow-scan:offset')).toBe('0');
  });

  it('KS-3257: cold-строка пересекается с hot → дедупится перед fetch', async () => {
    const shared = makeRow({
      roundId: 'r-shared',
      lichessRoundId: 'SHARED',
      ourCount: 5,
    });
    const hotOnly = makeRow({
      roundId: 'r-hot-only',
      lichessRoundId: 'HOT-ONLY',
      ourCount: 5,
    });
    const prisma = makePrismaQueue([[shared, hotOnly], [shared]]);
    const redis = makeRedis();
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
      slowScanBatchSize: 10,
      slowScanWrapAt: 100,
    });
    // shared в cold отфильтрован — fetch вызывается ровно 2 раза
    // (по 1 на каждую hot-строку, cold пуст после дедупа).
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(r.coldRounds).toBe(0);
  });

  it('KS-3257: некорректный offset в Redis (NaN / отрицательный / выше wrapAt) → reset на 0', async () => {
    const prisma = makePrismaQueue([[], []]);
    const redis = makeRedis();
    redis._store.set('broadcast:metric:slow-scan:offset', 'garbage');
    const fetchFn = jest.fn(async () => makePgnResponse(5));
    const r = await runGameCountCheckTick({
      prisma,
      redis,
      logger: makeLogger(),
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => {},
      maxBroadcasts: 50,
      slowScanBatchSize: 25,
      slowScanWrapAt: 100,
    });
    expect(r.coldOffset).toBe(0); // reset
    expect(prisma._calls[1].params).toEqual([750, 375]); // OFFSET = (50+0)*15
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
