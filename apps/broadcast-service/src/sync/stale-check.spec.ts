import { runStaleCheck } from './stale-check';

// KS-1700 Part A tests (ADR-022 §2.6 шаг 0 — конвертация с node:test на jest,
// перенос из apps/broadcast-worker/src/stale-check.test.ts). Покрывает чистую
// функцию `runStaleCheck` без TCP-коннектов.

type BroadcastRow = { id: string; lichessId: string; title: string };

function makePrisma(active: BroadcastRow[]) {
  const updates: Array<{ id: string; data: { isActive: boolean } }> = [];
  return {
    _updates: updates,
    broadcast: {
      findMany: async () => active,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { isActive: boolean };
      }) => {
        updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
  };
}

function makeRedis(initialCounts: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...initialCounts };
  const expires: Record<string, number> = {};
  const dels: string[] = [];
  return {
    _counts: counts,
    _expires: expires,
    _dels: dels,
    incr: async (k: string) => {
      counts[k] = (counts[k] ?? 0) + 1;
      return counts[k];
    },
    expire: async (k: string, ttl: number) => {
      expires[k] = ttl;
      return 1;
    },
    del: async (k: string) => {
      dels.push(k);
      if (k in counts) {
        delete counts[k];
        return 1;
      }
      return 0;
    },
  };
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

describe('runStaleCheck (KS-1700 Part A)', () => {
  let active: BroadcastRow[];

  beforeEach(() => {
    active = [
      { id: 'uuid-seen', lichessId: 'lichess-seen', title: 'Seen Tournament' },
      {
        id: 'uuid-missing',
        lichessId: 'lichess-missing',
        title: 'Missing Tournament',
      },
    ];
  });

  it('сбрасывает счётчик для видимых в top-20', async () => {
    const prisma = makePrisma(active);
    const redis = makeRedis({ 'pref:lichess-seen': 5 });
    const logger = makeLogger();

    const res = await runStaleCheck({
      prisma,
      redis,
      currentLichessIds: new Set(['lichess-seen', 'lichess-missing']),
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.reset).toBe(2);
    expect(res.marked).toBe(0);
    expect(prisma._updates).toHaveLength(0);
    expect(redis._dels).toContain('pref:lichess-seen');
  });

  it('инкрементит счётчик если не в top-20, не маркирует до N', async () => {
    const prisma = makePrisma(active);
    const redis = makeRedis();
    const logger = makeLogger();

    const res = await runStaleCheck({
      prisma,
      redis,
      currentLichessIds: new Set(['lichess-seen']), // missing отсутствует
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.incremented).toBe(1);
    expect(res.marked).toBe(0);
    expect(prisma._updates).toHaveLength(0);
    expect(redis._counts['pref:lichess-missing']).toBe(1);
    expect(redis._expires['pref:lichess-missing']).toBe(43200);
  });

  it('маркирует isActive=false после N-го пропуска', async () => {
    const prisma = makePrisma(active);
    // Счётчик уже 71, этот цикл будет 72 → триггер.
    const redis = makeRedis({ 'pref:lichess-missing': 71 });
    const logger = makeLogger();

    const res = await runStaleCheck({
      prisma,
      redis,
      currentLichessIds: new Set(['lichess-seen']),
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.marked).toBe(1);
    expect(prisma._updates).toHaveLength(1);
    expect(prisma._updates[0]).toEqual({
      id: 'uuid-missing',
      data: { isActive: false },
    });
    expect(redis._dels).toContain('pref:lichess-missing');
    const markedLog = logger._lines.find((l) =>
      l.includes('marked isActive=false after 72 missed cycles'),
    );
    expect(markedLog).toBeTruthy();
  });

  it('не маркирует на 71-м пропуске (строгий порог >= N)', async () => {
    const prisma = makePrisma(active);
    const redis = makeRedis({ 'pref:lichess-missing': 70 });
    const logger = makeLogger();

    const res = await runStaleCheck({
      prisma,
      redis,
      currentLichessIds: new Set(['lichess-seen']),
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.marked).toBe(0);
    expect(prisma._updates).toHaveLength(0);
    expect(redis._counts['pref:lichess-missing']).toBe(71);
  });

  it('ошибка Redis incr не прерывает обход других broadcasts', async () => {
    const active3 = [
      ...active,
      { id: 'uuid-third', lichessId: 'lichess-third', title: 'Third' },
    ];
    const prisma = makePrisma(active3);
    const logger = makeLogger();

    const redis = {
      incr: async (k: string) => {
        if (k === 'pref:lichess-missing') throw new Error('redis down');
        return 1;
      },
      expire: async () => 1,
      del: async () => 1,
    };

    const res = await runStaleCheck({
      prisma,
      redis: redis as never,
      currentLichessIds: new Set(['lichess-seen']),
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.incremented).toBe(1);
    const warnLog = logger._lines.find((l) => l.includes('Redis incr failed'));
    expect(warnLog).toBeTruthy();
  });

  it('prisma.update fail не останавливает цикл', async () => {
    const prisma = {
      _updates: [] as unknown[],
      broadcast: {
        findMany: async () => active,
        update: async () => {
          throw new Error('db lost');
        },
      },
    };
    const redis = makeRedis({ 'pref:lichess-missing': 71 });
    const logger = makeLogger();

    const res = await runStaleCheck({
      prisma: prisma as never,
      redis,
      currentLichessIds: new Set(['lichess-seen']),
      staleCycles: 72,
      ttlSeconds: 43200,
      keyPrefix: 'pref:',
      logger,
    });

    expect(res.marked).toBe(0);
    const errLog = logger._lines.find((l) => l.includes('Failed to mark'));
    expect(errLog).toBeTruthy();
  });
});
