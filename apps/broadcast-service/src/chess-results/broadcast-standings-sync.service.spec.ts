import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BroadcastStandingsSyncService } from './broadcast-standings-sync.service';
import { ChessResultsFetcher } from './chess-results-fetcher';
import { MetricsService } from '../metrics/metrics.service';

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'chess-results',
);
const loadFixture = (n: string): string =>
  readFileSync(join(FIXTURES_DIR, n), 'utf8');

/**
 * KS-1733 — спека для `BroadcastStandingsSyncService`. Тестируем основные
 * ветки `getFresh` / `refresh` с моками Prisma + Redis + Fetcher.
 *
 * Структура моков:
 *   - `prisma.broadcast.findUnique` — возвращает Broadcast c rounds+games.
 *   - `prisma.broadcastStandings.findUnique` / `upsert` — кэш-операции.
 *   - `prisma.$queryRaw` — для `computeLifecycle` (возвращает {has_live,
 *     has_upcoming}).
 *   - `redis.set/get/del` — Redis-lock dedup.
 *   - `fetcher.fetchPage` — chess-results HTML.
 */

const NOW = 1_700_000_000_000;
const TTL_LIVE_MS = 5 * 60 * 1000;

interface MockPrisma {
  broadcastFindUnique: jest.Mock;
  standingsFindUnique: jest.Mock;
  standingsUpsert: jest.Mock;
  queryRaw: jest.Mock;
}

interface MockRedis {
  set: jest.Mock;
  del: jest.Mock;
  get: jest.Mock;
}

function makePrisma(opts: {
  broadcast?: unknown;
  standings?: unknown;
  lifecycle?: 'live' | 'upcoming' | 'finished';
} = {}): MockPrisma {
  const lifecycle = opts.lifecycle ?? 'live';
  const queryRaw = jest.fn().mockResolvedValue([
    {
      has_live: lifecycle === 'live',
      has_upcoming: lifecycle === 'upcoming',
    },
  ]);
  return {
    broadcastFindUnique: jest.fn().mockResolvedValue(opts.broadcast ?? null),
    standingsFindUnique: jest.fn().mockResolvedValue(opts.standings ?? null),
    standingsUpsert: jest.fn().mockResolvedValue({}),
    queryRaw,
  };
}

function makeRedis(opts: { lockAcquired?: boolean } = {}): MockRedis {
  return {
    set: jest
      .fn()
      .mockResolvedValue(opts.lockAcquired === false ? null : 'OK'),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
  };
}

function makeFetcher(impl?: jest.Mock): ChessResultsFetcher {
  const fetcher = {
    fetchPage:
      impl ?? jest.fn().mockResolvedValue('<html></html>'),
  };
  return fetcher as unknown as ChessResultsFetcher;
}

function makeService(opts: {
  prisma: MockPrisma;
  redis: MockRedis;
  fetcher: ChessResultsFetcher;
  now?: number;
}): BroadcastStandingsSyncService {
  const metrics = new MetricsService();
  const prismaShim = {
    broadcast: { findUnique: opts.prisma.broadcastFindUnique },
    broadcastStandings: {
      findUnique: opts.prisma.standingsFindUnique,
      upsert: opts.prisma.standingsUpsert,
    },
    $queryRaw: opts.prisma.queryRaw,
  };
  const nowFn = () => opts.now ?? NOW;
  return new BroadcastStandingsSyncService(
    prismaShim as never,
    opts.redis as never,
    opts.fetcher,
    metrics,
    { now: nowFn, sleep: () => Promise.resolve() },
  );
}

const baseBroadcast = {
  id: 'bc-1',
  format: '12-player round-robin',
  teamTable: false,
  chessResultsTournamentId: '1395782',
  rounds: [
    {
      id: 'round-1',
      name: 'Round 1',
      startsAt: new Date('2026-04-01T15:00:00Z'),
      games: [],
    },
  ],
};

describe('BroadcastStandingsSyncService — getFresh cache hit', () => {
  it('свежий кэш → возвращает materialized + не зовёт fetcher', async () => {
    const cached = {
      id: 'st-1',
      broadcastId: 'bc-1',
      sourceType: 'chess-results',
      sourceUrl: 'https://chess-results.com/tnr1.aspx',
      tournamentType: 'round-robin',
      rawPlayers: [
        {
          rank: 1,
          name: 'Player A',
          normalizedName: 'player a',
          points: 5,
          gamesPlayed: 5,
        },
      ],
      rawCrossTable: [[{ result: null }]],
      rawPairings: null,
      rawTeams: null,
      fetchedAt: new Date(NOW - 60_000),
      staleAt: new Date(NOW + TTL_LIVE_MS),
      fetchError: null,
    };
    const prisma = makePrisma({ standings: cached });
    const redis = makeRedis();
    const fetcherMock = jest.fn();
    const fetcher = makeFetcher(fetcherMock);
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.getFresh('bc-1');

    expect(r.tournamentType).toBe('round-robin');
    expect(r.players).toHaveLength(1);
    expect(fetcherMock).not.toHaveBeenCalled();
    expect(prisma.standingsUpsert).not.toHaveBeenCalled();
  });
});

describe('BroadcastStandingsSyncService — getFresh stale', () => {
  it('устаревший кэш → отдаёт устаревшее, async-refresh запускается', async () => {
    const cached = {
      id: 'st-2',
      broadcastId: 'bc-1',
      sourceType: 'chess-results',
      sourceUrl: 'https://chess-results.com/tnr1.aspx',
      tournamentType: 'round-robin',
      rawPlayers: [],
      rawCrossTable: [[]],
      rawPairings: null,
      rawTeams: null,
      fetchedAt: new Date(NOW - 10 * 60 * 1000),
      staleAt: new Date(NOW - 1000),
      fetchError: null,
    };
    const prisma = makePrisma({ standings: cached, broadcast: baseBroadcast });
    const redis = makeRedis();
    // fetcher для async refresh.
    const html = loadFixture('rr-art5-crosstable.html');
    const fetcher = makeFetcher(jest.fn().mockResolvedValue(html));
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.getFresh('bc-1');
    // Возврат — устаревшая запись.
    expect(r.tournamentType).toBe('round-robin');

    // Подождём микротаски — async refresh должен дойти до upsert.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // Async refresh должен был стартовать.
    expect(redis.set).toHaveBeenCalled();
  });
});

describe('BroadcastStandingsSyncService — refresh internal-fallback (KS-1749)', () => {
  it('round-robin format без chess-results-id → tournamentType=round-robin (НЕ unknown), internal-fallback', async () => {
    const broadcast = {
      ...baseBroadcast,
      // format='12-player round-robin' уже в baseBroadcast → round-robin.
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const redis = makeRedis();
    const fetcherMock = jest.fn();
    const fetcher = makeFetcher(fetcherMock);
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    expect(r.sourceUrl).toBeNull();
    expect(r.fetchedAt).toBeNull();
    expect(fetcherMock).not.toHaveBeenCalled();
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);

    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    expect(upsert.create.tournamentType).toBe('round-robin');
    expect(upsert.create.sourceType).toBe('internal-fallback');
    expect(upsert.create.fetchError).toMatch(/chessResultsTournamentId is null/);
  });

  it('team-round-robin format без chess-results-id → teams[] построен из players[].team (Bundesliga-кейс)', async () => {
    // Регрессия KS-1749: Bundesliga (10-team double round-robin) без
    // chess-results URL должна показывать team-round-robin тип, фронт
    // уйдёт в <TeamStandings>. Ранее возвращался unknown → empty-state.
    const broadcast = {
      ...baseBroadcast,
      format: '10-team double round-robin', // → team-round-robin
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-04-01T15:00:00Z'),
          games: [
            {
              id: 'g1',
              roundId: 'round-1',
              whitePlayer: 'Smith, A',
              blackPlayer: 'Jones, B',
              whiteElo: 2400,
              blackElo: 2350,
              result: '1-0',
              pgn:
                '[White "Smith, A"]\n[Black "Jones, B"]\n' +
                '[WhiteTeam "Hamburg"]\n[BlackTeam "Berlin"]\n' +
                '[Result "1-0"]\n\n1. e4 e5 1-0',
            },
            {
              id: 'g2',
              roundId: 'round-1',
              whitePlayer: 'Brown, C',
              blackPlayer: 'Davis, D',
              whiteElo: 2300,
              blackElo: 2280,
              result: '1/2-1/2',
              pgn:
                '[White "Brown, C"]\n[Black "Davis, D"]\n' +
                '[WhiteTeam "Hamburg"]\n[BlackTeam "Berlin"]\n' +
                '[Result "1/2-1/2"]\n\n1. d4 d5 1/2-1/2',
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('team-round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    if (
      r.tournamentType !== 'team-round-robin' &&
      r.tournamentType !== 'team-swiss'
    )
      return;
    // Players с заполненным team из PGN-тэгов.
    expect(r.players).toHaveLength(4);
    const smith = r.players.find((p) => p.name === 'Smith, A');
    expect(smith?.team).toBe('Hamburg');
    const jones = r.players.find((p) => p.name === 'Jones, B');
    expect(jones?.team).toBe('Berlin');
    // Teams собраны группировкой и отсортированы по points desc.
    expect(r.teams.map((t) => t.name).sort()).toEqual(['Berlin', 'Hamburg']);
    // Hamburg = 1.0 (Smith win) + 0.5 (Brown draw) = 1.5
    // Berlin  = 0.0 (Jones loss) + 0.5 (Davis draw) = 0.5
    const hamburg = r.teams.find((t) => t.name === 'Hamburg');
    const berlin = r.teams.find((t) => t.name === 'Berlin');
    expect(hamburg?.points).toBe(1.5);
    expect(berlin?.points).toBe(0.5);
    expect(hamburg?.rank).toBe(1);
    expect(berlin?.rank).toBe(2);
  });

  it('swiss format без chess-results-id → tournamentType=swiss, минимальный shape', async () => {
    const broadcast = {
      ...baseBroadcast,
      format: '9-round Swiss', // → swiss
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('swiss');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'swiss') return;
    expect(r.roundCount).toBe(0);
    expect(r.pairings).toEqual([]);
  });

  it('format не распознан (Knockout) → unknown + CrosstableLegacy (единственный legit unknown)', async () => {
    const broadcast = {
      ...baseBroadcast,
      format: 'Knockout',
      chessResultsTournamentId: '1234', // даже если есть id, unknown blocks fetch
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const fetcherMock = jest.fn();
    const fetcher = makeFetcher(fetcherMock);
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    expect(r.tournamentType).toBe('unknown');
    if (r.tournamentType !== 'unknown') return;
    expect(r.reason).toMatch(/tournamentType='unknown'/);
    expect(fetcherMock).not.toHaveBeenCalled();
  });
});

describe('BroadcastStandingsSyncService — refresh round-robin happy', () => {
  it('round-robin → fetch art=5 → parsed → CrosstableRoundRobin + persist', async () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const fetchPage = jest.fn().mockResolvedValue(html);
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: baseBroadcast, lifecycle: 'live' });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('chess-results');
    if (r.tournamentType !== 'round-robin') return;
    expect(r.matrix.length).toBeGreaterThan(0);
    expect(fetchPage).toHaveBeenCalledWith('1395782', 5, 'live');
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
  });
});

describe('BroadcastStandingsSyncService — fetch error → internal-fallback (KS-1749)', () => {
  it('fetcher throws (round-robin) → internal-fallback с tournamentType=round-robin', async () => {
    const fetchPage = jest
      .fn()
      .mockRejectedValue(new Error('upstream 503'));
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: baseBroadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    // Detected тип сохраняется (KS-1749, корректировка KS-1745).
    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    expect(upsert.create.tournamentType).toBe('round-robin');
    expect(upsert.create.sourceType).toBe('internal-fallback');
    // fetchError для аудита (через persist).
    expect(upsert.create.fetchError ?? '').toMatch(/upstream 503/);
  });

  it('KS-1749: fetcher throws на team-rr → tournamentType=team-round-robin (НЕ unknown)', async () => {
    // Главный сценарий KS-1749 (корректировка KS-1745): для team-турнира
    // с chess-results-id, при fetch fail — discriminator должен остаться
    // team-round-robin. До корректировки писали unknown → empty-state UI.
    const teamBroadcast = {
      ...baseBroadcast,
      format: '12-team round-robin', // → tournamentType = 'team-round-robin'
      chessResultsTournamentId: '1234',
    };
    const fetchPage = jest
      .fn()
      .mockRejectedValue(new Error('chess-results timeout'));
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: teamBroadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('team-round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    expect(upsert.create.tournamentType).toBe('team-round-robin');
    expect(upsert.update.tournamentType).toBe('team-round-robin');
    expect(upsert.create.sourceType).toBe('internal-fallback');
    expect(upsert.create.fetchError).toMatch(/chess-results timeout/);
  });

  it('KS-1749: chessResultsTournamentId=null + format=swiss → tournamentType=swiss', async () => {
    const broadcast = {
      ...baseBroadcast,
      format: '9-round Swiss',
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    await svc.refresh('bc-1');

    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    // Detected тип сохраняется, разу что format распознан.
    expect(upsert.create.tournamentType).toBe('swiss');
  });
});

describe('BroadcastStandingsSyncService — getFresh miss + lock', () => {
  it('нет кэша → берёт lock → refresh → persist → return', async () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const fetchPage = jest.fn().mockResolvedValue(html);
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: baseBroadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.getFresh('bc-1');

    expect(r.tournamentType).toBe('round-robin');
    expect(redis.set).toHaveBeenCalledWith(
      'broadcast:standings:lock:bc-1',
      expect.any(String),
      'EX',
      30,
      'NX',
    );
    expect(redis.del).toHaveBeenCalledWith('broadcast:standings:lock:bc-1');
  });

  it('lock занят, БД пуста, polling выбирает свежую запись', async () => {
    let pollCount = 0;
    const cachedReady = {
      id: 'st',
      broadcastId: 'bc-1',
      sourceType: 'chess-results',
      sourceUrl: null,
      tournamentType: 'round-robin',
      rawPlayers: [],
      rawCrossTable: [[]],
      rawPairings: null,
      rawTeams: null,
      fetchedAt: new Date(NOW),
      staleAt: new Date(NOW + TTL_LIVE_MS),
      fetchError: null,
    };
    const prisma = makePrisma({ broadcast: baseBroadcast });
    // findUnique для standings: первый вызов (в getFresh) → null,
    // дальнейшие — постепенно появляется.
    prisma.standingsFindUnique.mockImplementation(async () => {
      pollCount++;
      return pollCount > 2 ? cachedReady : null;
    });
    const redis = makeRedis({ lockAcquired: false });
    const fetcher = makeFetcher();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.getFresh('bc-1');
    expect(r.tournamentType).toBe('round-robin');
    expect(prisma.standingsFindUnique.mock.calls.length).toBeGreaterThan(2);
    // Fetcher НЕ вызывался — мы дождались чужого refresh.
    expect((fetcher.fetchPage as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('BroadcastStandingsSyncService — broadcast not found', () => {
  it('throws Error если broadcast не существует', async () => {
    const prisma = makePrisma({ broadcast: null });
    const redis = makeRedis();
    const fetcher = makeFetcher();
    const svc = makeService({ prisma, redis, fetcher });
    await expect(svc.refresh('bc-missing')).rejects.toThrow(/not found/);
  });
});
