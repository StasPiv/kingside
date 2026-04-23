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

describe('BroadcastStandingsSyncService — refresh legacy fallback', () => {
  it('chessResultsTournamentId=null → CrosstableLegacy + persist', async () => {
    const broadcast = {
      ...baseBroadcast,
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const redis = makeRedis();
    const fetcherMock = jest.fn();
    const fetcher = makeFetcher(fetcherMock);
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');

    expect(r.tournamentType).toBe('unknown');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'unknown') return;
    expect(r.reason).toMatch(/chessResultsTournamentId is null/);
    expect(fetcherMock).not.toHaveBeenCalled();
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
  });

  it('format не свопадает с известными типами → unknown → legacy', async () => {
    const broadcast = {
      ...baseBroadcast,
      format: 'Knockout',
      chessResultsTournamentId: '1234',
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

describe('BroadcastStandingsSyncService — refresh fetch error → legacy', () => {
  it('fetcher throws → CrosstableLegacy', async () => {
    const fetchPage = jest
      .fn()
      .mockRejectedValue(new Error('upstream 503'));
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: baseBroadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    expect(r.tournamentType).toBe('unknown');
    if (r.tournamentType !== 'unknown') return;
    expect(r.reason).toMatch(/upstream 503/);
    // Persist всё равно был — кэшируем legacy чтобы не долбить fetcher.
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
  });

  it('KS-1745: persisted tournamentType = "unknown" (НЕ исходный team-rr)', async () => {
    // Регрессия: на Bundesliga (team-round-robin) detectTournamentType
    // возвращает 'team-round-robin', и до фикса persist писал именно его
    // в БД, хотя response уже был CrosstableLegacy с
    // tournamentType='unknown'. UI-диспетчер уходил в <TeamStandings>
    // с пустым teams[] → empty-state, хотя players был.
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

    // Возврат — legacy с tournamentType='unknown'.
    expect(r.tournamentType).toBe('unknown');

    // Главный инвариант KS-1745: persisted tournamentType — 'unknown',
    // НЕ 'team-round-robin'. UI получит CrosstableLegacy от диспетчера.
    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = prisma.standingsUpsert.mock.calls[0][0];
    expect(upsertCall.create.tournamentType).toBe('unknown');
    expect(upsertCall.update.tournamentType).toBe('unknown');
    // sourceType — internal-fallback (как было).
    expect(upsertCall.create.sourceType).toBe('internal-fallback');
    // fetchError содержит причину (для аудита).
    expect(upsertCall.create.fetchError).toMatch(/chess-results timeout/);
  });

  it('KS-1745: legacy ветка для chessResultsTournamentId=null тоже пишет unknown', async () => {
    // Та же логика и для broadcast'ов без chess-results id (Lichess
    // standings_url ведёт не на chess-results).
    const broadcast = {
      ...baseBroadcast,
      format: '9-round Swiss', // → tournamentType = 'swiss'
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const fetcher = makeFetcher();
    const svc = makeService({ prisma, redis, fetcher });

    await svc.refresh('bc-1');

    expect(prisma.standingsUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = prisma.standingsUpsert.mock.calls[0][0];
    expect(upsertCall.create.tournamentType).toBe('unknown');
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
