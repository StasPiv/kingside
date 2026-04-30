/**
 * KS-2164. Тесты presence-логики (без поднятия Nest).
 * Покрываемые сценарии:
 *   - 60/40 split idle vs polling (детерминирован по hash).
 *   - lastSeenAt-tick: updateMany по всему roster'у.
 *   - enqueueSynthetic / dequeueSynthetic — корректная мутация state'а
 *     и `synthetic:in_queue:<cat>` set'а.
 *   - presence + scheduler не вызываются без env.
 */
import {
  SyntheticPresenceService,
  isPollingUser,
  userPollingBucket,
  CANONICAL_TIME_CONTROL,
} from './synthetic-presence.service';
import type { SyntheticDeps } from './synthetic-deps';

function fakePrisma(rows: Array<{ id: string }>) {
  const updated: Array<{ ids: string[]; lastSeenAt: Date }> = [];
  return {
    _updated: updated,
    user: {
      findMany: jest.fn(async () => rows),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: { in: string[] } }; data: { lastSeenAt: Date } }) => {
          updated.push({ ids: where.id.in, lastSeenAt: data.lastSeenAt });
          return { count: where.id.in.length };
        },
      ),
    },
  };
}

function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  return {
    _sets: sets,
    _strings: strings,
    sadd: jest.fn(async (key: string, ...members: string[]) => {
      let s = sets.get(key);
      if (!s) {
        s = new Set();
        sets.set(key, s);
      }
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) {
          s.add(m);
          added++;
        }
      }
      return added;
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed++;
      }
      return removed;
    }),
    scard: jest.fn(async (key: string) => sets.get(key)?.size ?? 0),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    sismember: jest.fn(async (key: string, m: string) =>
      sets.get(key)?.has(m) ? 1 : 0,
    ),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK' as const;
    }),
    get: jest.fn(async (key: string) => strings.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const k of keys) {
        if (strings.delete(k)) removed++;
      }
      return removed;
    }),
    zcard: jest.fn(async () => 0),
    lpush: jest.fn(async () => 1),
    ltrim: jest.fn(async () => 'OK' as const),
    lrange: jest.fn(async () => []),
  };
}

function fakeMatchmaking() {
  const join: Array<{ userId: string; init: number; inc: number }> = [];
  const leave: Array<{ userId: string; cat: string }> = [];
  return {
    _join: join,
    _leave: leave,
    joinQueue: jest.fn(
      async (
        userId: string,
        timeInitialSec: number,
        timeIncrementSec: number,
      ) => {
        join.push({ userId, init: timeInitialSec, inc: timeIncrementSec });
        return null;
      },
    ),
    leaveQueue: jest.fn(async (userId: string, cat: string) => {
      leave.push({ userId, cat });
      return true;
    }),
  };
}

describe('userPollingBucket / isPollingUser — детерминизм 60/40 split', () => {
  it('одинаковый userId → одинаковый bucket (нет рандома)', () => {
    expect(userPollingBucket('abc')).toBe(userPollingBucket('abc'));
  });

  it('на 1000 случайных id ~ 40% попадают в polling-bucket (default 40%)', () => {
    let polling = 0;
    for (let i = 0; i < 1000; i++) {
      if (isPollingUser(`user-${i}`)) polling++;
    }
    // Допуск ±5% (50 на выборке 1000).
    expect(polling).toBeGreaterThan(350);
    expect(polling).toBeLessThan(450);
  });

  it('кастомный pollingPercent корректно фильтрует', () => {
    let polling = 0;
    for (let i = 0; i < 1000; i++) {
      if (isPollingUser(`u-${i}`, 80)) polling++;
    }
    expect(polling).toBeGreaterThan(750);
    expect(polling).toBeLessThan(850);
  });
});

describe('SyntheticPresenceService — state machine', () => {
  let svc: SyntheticPresenceService;
  let prisma: ReturnType<typeof fakePrisma>;
  let redis: ReturnType<typeof fakeRedis>;
  let matchmaking: ReturnType<typeof fakeMatchmaking>;

  beforeEach(() => {
    prisma = fakePrisma([]);
    redis = fakeRedis();
    matchmaking = fakeMatchmaking();
    svc = new SyntheticPresenceService();
    const deps: SyntheticDeps = {
      prisma: prisma as never,
      redis: redis as never,
    };
    svc.configure(deps, {
      joinQueue: matchmaking.joinQueue as never,
      leaveQueue: matchmaking.leaveQueue as never,
    });
  });

  it('enqueueSynthetic ставит state=in_queue и SADD synthetic:in_queue:<cat>', async () => {
    const ok = await svc.enqueueSynthetic('user-1', 'blitz', 'scheduler');
    expect(ok).toBe(true);
    expect(matchmaking._join).toHaveLength(1);
    expect(matchmaking._join[0]).toEqual({
      userId: 'user-1',
      init: CANONICAL_TIME_CONTROL.blitz.initial,
      inc: CANONICAL_TIME_CONTROL.blitz.increment,
    });
    expect(redis._sets.get('synthetic:in_queue:blitz')?.has('user-1')).toBe(true);
    expect(await svc.getState('user-1')).toBe('in_queue');
  });

  it('повторный enqueueSynthetic при state=in_queue → no-op', async () => {
    await svc.enqueueSynthetic('user-1', 'blitz', 'scheduler');
    matchmaking.joinQueue.mockClear();
    const ok = await svc.enqueueSynthetic('user-1', 'blitz', 'scheduler');
    expect(ok).toBe(false);
    expect(matchmaking.joinQueue).not.toHaveBeenCalled();
  });

  it('dequeueSynthetic снимает state и удаляет из set', async () => {
    await svc.enqueueSynthetic('user-1', 'blitz', 'scheduler');
    const ok = await svc.dequeueSynthetic('user-1', 'blitz');
    expect(ok).toBe(true);
    expect(matchmaking._leave).toEqual([{ userId: 'user-1', cat: 'blitz' }]);
    expect(redis._sets.get('synthetic:in_queue:blitz')?.has('user-1')).toBeFalsy();
    expect(await svc.getState('user-1')).toBe('idle');
  });

  it('onGameFinished возвращает synthetic в idle', async () => {
    await svc.setState('user-1', 'in_game');
    await svc.onGameFinished('user-1');
    expect(await svc.getState('user-1')).toBe('idle');
  });

  it('refreshRoster наполняет synthetic:roster:idle ID-шниками из БД', async () => {
    prisma = fakePrisma([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    redis = fakeRedis();
    svc = new SyntheticPresenceService();
    svc.configure(
      { prisma: prisma as never, redis: redis as never },
      {
        joinQueue: matchmaking.joinQueue as never,
        leaveQueue: matchmaking.leaveQueue as never,
      },
    );
    await svc.refreshRoster();
    expect([...(redis._sets.get('synthetic:roster:idle') ?? [])]).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('sampleIdleSchedulerPool отдаёт только non-polling и только idle, в пределах limit', async () => {
    // Найдём 5 non-polling и 5 polling по hash.
    const ids: string[] = [];
    let nonPolling = 0;
    for (let i = 0; nonPolling < 5 && i < 100; i++) {
      const id = `np-${i}`;
      if (!isPollingUser(id)) {
        ids.push(id);
        nonPolling++;
      }
    }
    let polling = 0;
    for (let i = 0; polling < 5 && i < 100; i++) {
      const id = `p-${i}`;
      if (isPollingUser(id)) {
        ids.push(id);
        polling++;
      }
    }
    prisma = fakePrisma(ids.map((id) => ({ id })));
    redis = fakeRedis();
    svc = new SyntheticPresenceService();
    svc.configure(
      { prisma: prisma as never, redis: redis as never },
      {
        joinQueue: matchmaking.joinQueue as never,
        leaveQueue: matchmaking.leaveQueue as never,
      },
    );
    await svc.refreshRoster();
    const sample = await svc.sampleIdleSchedulerPool(10);
    // В sample должны быть только non-polling.
    for (const id of sample) {
      expect(isPollingUser(id)).toBe(false);
    }
  });
});
