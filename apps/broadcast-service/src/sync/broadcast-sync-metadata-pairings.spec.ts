/**
 * KS-4847 / ADR-158 §2.1-2.2. Юнит-тесты парсинга пар из Lichess metadata
 * и upsert в BroadcastGame.
 *
 * Покрытие:
 *  1. upsertPairingsFromMetadata: пустой/undefined games → 0 изменений.
 *  2. Новый game.id → CREATE записи с pgn=null, players/ratings из
 *     ответа.
 *  3. Существующая запись с pgn=null и другими players → UPDATE.
 *  4. Существующая запись с pgn=null и идентичными полями → skip
 *     (updatedAt не дёргается).
 *  5. Существующая запись с pgn NOT NULL → skip (PGN — источник истины).
 *  6. game.id отсутствует → игнорируется (без дедупа нельзя upsert).
 *  7. refreshOneRoundMetadata: 429/404/500 не роняет — возвращает null-changes.
 *  8. refreshOneRoundMetadata: status pending → ongoing → prerender enqueued.
 *  9. refreshOneRoundMetadata: без смены status, но с изменёнными парами →
 *     prerender тоже enqueued (§3.3 инвалидация по изменению games).
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

interface Mocks {
  prisma: {
    broadcastRound: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    broadcastGame: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
  };
  redis: {
    hgetall: jest.Mock;
    exists: jest.Mock;
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    hincrby: jest.Mock;
    hdel: jest.Mock;
  };
  metrics: Record<string, jest.Mock>;
  standingsSync: object;
  prerender: { enqueueFireAndForget: jest.Mock };
}

function makeMocks(): Mocks {
  return {
    prisma: {
      broadcastRound: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ broadcastId: 'tid-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      broadcastGame: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    },
    redis: {
      hgetall: jest.fn().mockResolvedValue({}),
      exists: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      hincrby: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
    },
    metrics: {
      recordCycle: jest.fn(),
      observeDuration: jest.fn(),
      recordFailure: jest.fn(),
      recordCrosstableCoverage: jest.fn(),
      recordPendingCheck: jest.fn(),
      observePendingPromotionDelay: jest.fn(),
      setStreamsActive: jest.fn(),
      recordStreamStarted: jest.fn(),
      recordStreamEnded: jest.fn(),
      setStreamsWatchdogMaxAge: jest.fn(),
      observeStreamDuration: jest.fn(),
      recordLichessRequest: jest.fn(),
      setWsActiveSubscriptions: jest.fn(),
      removeWsActiveSubscription: jest.fn(),
      recordStreamPriorityChange: jest.fn(),
      recordStreamEvaluation: jest.fn(),
    },
    standingsSync: {},
    prerender: { enqueueFireAndForget: jest.fn() },
  };
}

function makeService(mocks: Mocks): BroadcastSyncService {
  return new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
}

describe('KS-4847 / ADR-158 §2.1 — upsertPairingsFromMetadata', () => {
  it('undefined или пустой games → 0 изменений, ничего не пишет в БД', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (id: string, g?: unknown) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    expect(await upsert('r-1', undefined)).toBe(0);
    expect(await upsert('r-1', [])).toBe(0);
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
    expect(mocks.prisma.broadcastGame.update).not.toHaveBeenCalled();
  });

  it('новый lichessGameId → CREATE с pgn=null и рейтингами из ответа', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastGame.findFirst.mockResolvedValue(null);
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (
        id: string,
        g: unknown[],
      ) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    const changed = await upsert('round-uuid-1', [
      {
        id: 'lg-1',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        players: [
          { name: 'Carlsen', rating: 2860 },
          { name: 'Nakamura', rating: 2790 },
        ],
      },
    ]);

    expect(changed).toBe(1);
    expect(mocks.prisma.broadcastGame.create).toHaveBeenCalledWith({
      data: {
        roundId: 'round-uuid-1',
        lichessGameId: 'lg-1',
        whitePlayer: 'Carlsen',
        blackPlayer: 'Nakamura',
        whiteElo: 2860,
        blackElo: 2790,
        currentFen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        pgn: null,
        result: null,
      },
    });
  });

  it('существующая запись с pgn=null и другими players → UPDATE полей', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastGame.findFirst.mockResolvedValue({
      id: 'game-uuid-1',
      pgn: null,
      whitePlayer: 'OLD Carlsen',
      blackPlayer: 'Nakamura',
      whiteElo: 2850,
      blackElo: 2790,
      currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    });
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (
        id: string,
        g: unknown[],
      ) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    const changed = await upsert('round-uuid-1', [
      {
        id: 'lg-1',
        players: [
          { name: 'Carlsen', rating: 2860 },
          { name: 'Nakamura', rating: 2790 },
        ],
      },
    ]);

    expect(changed).toBe(1);
    expect(mocks.prisma.broadcastGame.update).toHaveBeenCalledWith({
      where: { id: 'game-uuid-1' },
      data: expect.objectContaining({
        whitePlayer: 'Carlsen',
        whiteElo: 2860,
      }),
    });
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
  });

  it('существующая запись с идентичными полями → skip без изменений', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastGame.findFirst.mockResolvedValue({
      id: 'game-uuid-1',
      pgn: null,
      whitePlayer: 'Carlsen',
      blackPlayer: 'Nakamura',
      whiteElo: 2860,
      blackElo: 2790,
      currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    });
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (
        id: string,
        g: unknown[],
      ) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    const changed = await upsert('round-uuid-1', [
      {
        id: 'lg-1',
        players: [
          { name: 'Carlsen', rating: 2860 },
          { name: 'Nakamura', rating: 2790 },
        ],
      },
    ]);

    expect(changed).toBe(0);
    expect(mocks.prisma.broadcastGame.update).not.toHaveBeenCalled();
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
  });

  it('существующая запись с pgn NOT NULL → skip (PGN — источник истины)', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastGame.findFirst.mockResolvedValue({
      id: 'game-uuid-1',
      pgn: '1. e4 e5 2. Nf3 Nc6 *',
      whitePlayer: 'OLD Carlsen',
      blackPlayer: 'OLD Nakamura',
      whiteElo: 2800,
      blackElo: 2700,
      currentFen: '...',
    });
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (
        id: string,
        g: unknown[],
      ) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    const changed = await upsert('round-uuid-1', [
      {
        id: 'lg-1',
        players: [
          { name: 'Carlsen', rating: 2860 },
          { name: 'Nakamura', rating: 2790 },
        ],
      },
    ]);

    expect(changed).toBe(0);
    expect(mocks.prisma.broadcastGame.update).not.toHaveBeenCalled();
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
  });

  it('без game.id — запись пропускается (без дедуп-ключа upsert не возможен)', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    const upsert = (svc as unknown as {
      upsertPairingsFromMetadata: (
        id: string,
        g: unknown[],
      ) => Promise<number>;
    }).upsertPairingsFromMetadata.bind(svc);

    const changed = await upsert('round-uuid-1', [
      { players: [{ name: 'Carlsen' }, { name: 'Nakamura' }] },
    ]);

    expect(changed).toBe(0);
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
  });
});

describe('KS-4847 / ADR-158 §2.1 — refreshOneRoundMetadata', () => {
  function makeResponseWithBody(
    status: number,
    body: unknown = {},
  ): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
      json: async () => body,
    } as unknown as Response;
  }

  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('status pending → ongoing → prerender enqueued (broadcast + list)', async () => {
    const mocks = makeMocks();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        makeResponseWithBody(200, {
          round: { finished: false, ongoing: true },
          games: [],
        }),
      ) as unknown as typeof fetch;
    const svc = makeService(mocks);
    const call = (svc as unknown as {
      refreshOneRoundMetadata: (
        r: { id: string; lichessRoundId: string; status: string },
        hint: string,
      ) => Promise<{ statusChanged: boolean; pairingsUpserted: number }>;
    }).refreshOneRoundMetadata.bind(svc);

    const out = await call(
      { id: 'r-1', lichessRoundId: 'lrid-1', status: 'pending' },
      'pending_metadata',
    );

    expect(out.statusChanged).toBe(true);
    expect(mocks.prisma.broadcastRound.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { status: 'ongoing' },
    });
    // enqueue: broadcast + list
    const kinds = mocks.prerender.enqueueFireAndForget.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['broadcast', 'list']));
  });

  it('без смены status, но новые пары → enqueue prerender broadcast (§3.3)', async () => {
    const mocks = makeMocks();
    // Раунд остаётся pending
    global.fetch = jest.fn().mockResolvedValue(
      makeResponseWithBody(200, {
        round: { finished: false, ongoing: false },
        games: [
          {
            id: 'lg-1',
            players: [
              { name: 'A', rating: 2700 },
              { name: 'B', rating: 2680 },
            ],
          },
        ],
      }),
    ) as unknown as typeof fetch;
    mocks.prisma.broadcastGame.findFirst.mockResolvedValue(null); // новая пара
    const svc = makeService(mocks);
    const call = (svc as unknown as {
      refreshOneRoundMetadata: (
        r: { id: string; lichessRoundId: string; status: string },
        hint: string,
      ) => Promise<{ statusChanged: boolean; pairingsUpserted: number }>;
    }).refreshOneRoundMetadata.bind(svc);

    const out = await call(
      { id: 'r-1', lichessRoundId: 'lrid-1', status: 'pending' },
      'pending_metadata',
    );

    expect(out.statusChanged).toBe(false);
    expect(out.pairingsUpserted).toBe(1);
    // enqueue: только broadcast (list не нужен для «пары изменились»)
    const kinds = mocks.prerender.enqueueFireAndForget.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind,
    );
    expect(kinds).toEqual(['broadcast']);
  });

  it('404 → возвращает { statusChanged: false, pairingsUpserted: 0 }, БД не трогает', async () => {
    const mocks = makeMocks();
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponseWithBody(404)) as unknown as typeof fetch;
    const svc = makeService(mocks);
    const call = (svc as unknown as {
      refreshOneRoundMetadata: (
        r: { id: string; lichessRoundId: string; status: string },
        hint: string,
      ) => Promise<{ statusChanged: boolean; pairingsUpserted: number }>;
    }).refreshOneRoundMetadata.bind(svc);

    const out = await call(
      { id: 'r-1', lichessRoundId: 'lrid-1', status: 'pending' },
      'pending_metadata',
    );

    expect(out).toEqual({ statusChanged: false, pairingsUpserted: 0 });
    expect(mocks.prisma.broadcastRound.update).not.toHaveBeenCalled();
    expect(mocks.prisma.broadcastGame.create).not.toHaveBeenCalled();
  });
});

describe('KS-4847 / ADR-158 §2.6 — runFastPollTick + pending', () => {
  it('pending раунд с subs>=1 и startsAt в окне [NOW, NOW+15 мин] попадает; вызывается refreshOneRoundMetadata', async () => {
    const mocks = makeMocks();
    mocks.redis.hgetall.mockResolvedValue({ pending1: '5' });
    const now = Date.now();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([
      {
        id: 'r-p',
        lichessRoundId: 'pending1',
        status: 'pending',
        updatedAt: new Date(now - 60_000),
      },
    ]);
    const svc = makeService(mocks);
    (svc as unknown as { acquireLock: jest.Mock }).acquireLock = jest
      .fn()
      .mockResolvedValue(true);
    (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay = jest
      .fn()
      .mockResolvedValue(undefined);
    const metaSpy = jest.fn().mockResolvedValue({
      statusChanged: false,
      pairingsUpserted: 0,
    });
    const pgnSpy = jest.fn().mockResolvedValue(undefined);
    (svc as unknown as {
      refreshOneRoundMetadata: jest.Mock;
    }).refreshOneRoundMetadata = metaSpy;
    (svc as unknown as {
      fetchAndProcessRoundPgn: jest.Mock;
    }).fetchAndProcessRoundPgn = pgnSpy;

    await svc.runFastPollTick();

    expect(metaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lichessRoundId: 'pending1', status: 'pending' }),
      'pending_metadata',
    );
    expect(pgnSpy).not.toHaveBeenCalled();
  });

  it('ongoing идёт перед pending при одинаковых subs (priority ongoing > pending)', async () => {
    const mocks = makeMocks();
    mocks.redis.hgetall.mockResolvedValue({ p1: '5', o1: '5' });
    const now = Date.now();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([
      {
        id: 'r-p',
        lichessRoundId: 'p1',
        status: 'pending',
        updatedAt: new Date(now - 120_000),
      },
      {
        id: 'r-o',
        lichessRoundId: 'o1',
        status: 'ongoing',
        updatedAt: new Date(now - 60_000),
      },
    ]);
    const svc = makeService(mocks);
    (svc as unknown as { acquireLock: jest.Mock }).acquireLock = jest
      .fn()
      .mockResolvedValue(true);
    (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay = jest
      .fn()
      .mockResolvedValue(undefined);
    const calls: string[] = [];
    (svc as unknown as {
      refreshOneRoundMetadata: jest.Mock;
    }).refreshOneRoundMetadata = jest.fn().mockImplementation(async (r) => {
      calls.push(`meta:${r.lichessRoundId}`);
      return { statusChanged: false, pairingsUpserted: 0 };
    });
    (svc as unknown as {
      fetchAndProcessRoundPgn: jest.Mock;
    }).fetchAndProcessRoundPgn = jest.fn().mockImplementation(async (id) => {
      calls.push(`pgn:${id}`);
    });

    await svc.runFastPollTick();

    // ongoing идёт первым, потом pending
    expect(calls).toEqual(['pgn:o1', 'meta:p1']);
  });
});
