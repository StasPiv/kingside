/**
 * KS-2165 (B6). Тесты новой логики processQueue: live-priority,
 * synthetic-fallback, kill-switch (через scheduler.allocateSynthetic).
 *
 * Тестируем приватный `processQueue` через `(svc as any)`.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));
jest.mock('../redis/redis.service', () => ({ RedisService: jest.fn() }));

import { MatchmakingService } from './matchmaking.service';

interface QueueEntryPayload {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  joinedAt: number;
}

function makeRedis(initial: { queue?: string[]; syntheticIds?: string[] }) {
  const queue = [...(initial.queue ?? [])];
  const syntheticIds = new Set(initial.syntheticIds ?? []);
  return {
    _queue: queue,
    _synthetic: syntheticIds,
    zrange: jest.fn(async () => [...queue]),
    zrem: jest.fn(async (_key: string, ...members: string[]) => {
      for (const m of members) {
        const i = queue.indexOf(m);
        if (i >= 0) queue.splice(i, 1);
      }
      return members.length;
    }),
    smembers: jest.fn(async (_key: string) => [...syntheticIds]),
    hset: jest.fn(async () => 1),
    publish: jest.fn(async () => 0),
  };
}

function makePrisma() {
  let gameSeq = 0;
  const created: Array<{
    whiteId: string;
    blackId: string;
    isSyntheticOpponent: boolean;
  }> = [];
  return {
    _games: created,
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        username: `user-${where.id.slice(0, 4)}`,
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      })),
      findUniqueOrThrow: jest.fn(),
    },
    game: {
      create: jest.fn(async ({ data }: { data: typeof created[number] & {} }) => {
        gameSeq++;
        created.push({
          whiteId: data.whiteId,
          blackId: data.blackId,
          isSyntheticOpponent: data.isSyntheticOpponent ?? false,
        });
        return { id: `game-${gameSeq}` };
      }),
    },
  };
}

function makeScheduler(allocate: { userId: string; rating: number; username: string } | null) {
  return {
    allocateSynthetic: jest.fn(async () => allocate),
  };
}

function entry(p: QueueEntryPayload): string {
  return JSON.stringify(p);
}

async function runProcessQueue(
  svc: MatchmakingService,
  category: 'bullet' | 'blitz' | 'rapid' | 'classical',
): Promise<void> {
  await (svc as unknown as {
    processQueue: (cat: string) => Promise<void>;
  }).processQueue(category);
}

describe('MatchmakingService.processQueue — KS-2165 pairing rules', () => {
  it('live-priority: 2 live + 1 synthetic → live-vs-live, synthetic остаётся', async () => {
    const live1 = { userId: 'u1', rating: 1500, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const live2 = { userId: 'u2', rating: 1520, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const synth = { userId: 's1', rating: 1500, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const redis = makeRedis({
      queue: [entry(live1), entry(live2), entry(synth)],
      syntheticIds: ['s1'],
    });
    const prisma = makePrisma();
    const scheduler = makeScheduler(null);
    const svc = new MatchmakingService(redis as never, prisma as never, scheduler as never);

    await runProcessQueue(svc, 'blitz');

    expect(prisma._games).toHaveLength(1);
    const g = prisma._games[0];
    // Пара live-vs-live: ни один из участников НЕ synthetic.
    expect(['u1', 'u2']).toContain(g.whiteId);
    expect(['u1', 'u2']).toContain(g.blackId);
    expect(g.isSyntheticOpponent).toBe(false);
    // s1 остался в очереди.
    expect(redis._queue.some((m) => JSON.parse(m).userId === 's1')).toBe(true);
  });

  it('1 live + 1 synthetic в очереди → пара live-vs-synthetic с isSyntheticOpponent=true', async () => {
    const live = { userId: 'u1', rating: 1500, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const synth = { userId: 's1', rating: 1490, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const redis = makeRedis({
      queue: [entry(live), entry(synth)],
      syntheticIds: ['s1'],
    });
    const prisma = makePrisma();
    const scheduler = makeScheduler(null);
    const svc = new MatchmakingService(redis as never, prisma as never, scheduler as never);

    await runProcessQueue(svc, 'blitz');

    expect(prisma._games).toHaveLength(1);
    const g = prisma._games[0];
    expect([g.whiteId, g.blackId]).toContain('s1');
    expect([g.whiteId, g.blackId]).toContain('u1');
    expect(g.isSyntheticOpponent).toBe(true);
  });

  it('1 live, 0 synthetic в очереди + waited >= threshold → allocateSynthetic + пара', async () => {
    const live = {
      userId: 'u1',
      rating: 1500,
      timeInitialSec: 300,
      timeIncrementSec: 0,
      joinedAt: Date.now() - 30_000, // ждёт 30 сек, выше threshold (5..15s)
    };
    const redis = makeRedis({ queue: [entry(live)], syntheticIds: [] });
    const prisma = makePrisma();
    const scheduler = makeScheduler({
      userId: 's-allocated',
      rating: 1480,
      username: 'AllocSynth',
    });
    const svc = new MatchmakingService(redis as never, prisma as never, scheduler as never);

    await runProcessQueue(svc, 'blitz');

    expect(scheduler.allocateSynthetic).toHaveBeenCalledWith(1500, 'blitz');
    expect(prisma._games).toHaveLength(1);
    expect(prisma._games[0].isSyntheticOpponent).toBe(true);
    expect([prisma._games[0].whiteId, prisma._games[0].blackId]).toContain('s-allocated');
  });

  it('1 live, 0 synthetic + waited < threshold → не дёргаем scheduler, пары нет', async () => {
    const live = {
      userId: 'u1',
      rating: 1500,
      timeInitialSec: 300,
      timeIncrementSec: 0,
      joinedAt: Date.now() - 1_000, // 1 секунда — ниже минимального threshold 5 сек
    };
    const redis = makeRedis({ queue: [entry(live)] });
    const prisma = makePrisma();
    const scheduler = makeScheduler(null);
    const svc = new MatchmakingService(redis as never, prisma as never, scheduler as never);

    await runProcessQueue(svc, 'blitz');

    expect(scheduler.allocateSynthetic).not.toHaveBeenCalled();
    expect(prisma._games).toHaveLength(0);
  });

  it('scheduler.allocateSynthetic вернул null (kill-switch) → пары нет, пользователь продолжает ждать', async () => {
    const live = {
      userId: 'u1',
      rating: 1500,
      timeInitialSec: 300,
      timeIncrementSec: 0,
      joinedAt: Date.now() - 30_000,
    };
    const redis = makeRedis({ queue: [entry(live)] });
    const prisma = makePrisma();
    const scheduler = makeScheduler(null); // killed
    const svc = new MatchmakingService(redis as never, prisma as never, scheduler as never);

    await runProcessQueue(svc, 'blitz');

    expect(scheduler.allocateSynthetic).toHaveBeenCalledTimes(1);
    expect(prisma._games).toHaveLength(0);
    // entry остался в очереди.
    expect(redis._queue).toHaveLength(1);
  });

  it('scheduler не задан вообще (Optional) → fallback не работает, but live-pairing остаётся', async () => {
    const live1 = { userId: 'u1', rating: 1500, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const live2 = { userId: 'u2', rating: 1500, timeInitialSec: 300, timeIncrementSec: 0, joinedAt: 0 };
    const redis = makeRedis({ queue: [entry(live1), entry(live2)] });
    const prisma = makePrisma();
    const svc = new MatchmakingService(redis as never, prisma as never);

    await runProcessQueue(svc, 'blitz');

    expect(prisma._games).toHaveLength(1);
  });
});
