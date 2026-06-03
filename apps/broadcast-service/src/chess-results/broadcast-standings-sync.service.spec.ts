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
  broadcastUpdate: jest.Mock;
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
    broadcastUpdate: jest.fn().mockResolvedValue({}),
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

function makeFetcher(
  impl?: jest.Mock,
  searchImpl?: jest.Mock,
): ChessResultsFetcher {
  const fetcher = {
    fetchPage:
      impl ?? jest.fn().mockResolvedValue('<html></html>'),
    searchTournamentByTitle:
      searchImpl ?? jest.fn().mockResolvedValue([]),
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
    broadcast: {
      findUnique: opts.prisma.broadcastFindUnique,
      update: opts.prisma.broadcastUpdate,
    },
    broadcastStandings: {
      findUnique: opts.prisma.standingsFindUnique,
      upsert: opts.prisma.standingsUpsert,
    },
    $queryRaw: opts.prisma.queryRaw,
  };
  const nowFn = () => opts.now ?? NOW;
  // KS-3540: LichessBroadcastPlayersFetcher шим — всегда возвращает
  // пустой список, поэтому enrichWithLichessPlayers — no-op для всех
  // существующих тестов. Покрытие enrichment'а проводится отдельным
  // describe (см. ниже по файлу).
  const lichessPlayers = {
    fetchPlayers: jest.fn().mockResolvedValue([]),
  };
  return new BroadcastStandingsSyncService(
    prismaShim as never,
    opts.redis as never,
    opts.fetcher,
    lichessPlayers as never,
    metrics,
    { now: nowFn, sleep: () => Promise.resolve() },
  );
}

const baseBroadcast = {
  id: 'bc-1',
  title: 'Test Broadcast',
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

describe('BroadcastStandingsSyncService — KS-2479 TTL для internal-fallback', () => {
  // У трансляций без chess-results URL (TCEC, Sardinia, региональные
  // open'ы) lifecycle часто определяется как `finished` (раунды
  // status=pending без startsAt в окне), и TTL для persisted-кэша
  // ставится +24h. Это блокировало автоматическое распространение
  // фиксов internal-fallback'а на проде. KS-2479: для internal-fallback
  // с detected-типом TTL принудительно = live (5 min).

  it('internal-fallback round-robin + lifecycle=finished → staleAt = +5min (KS-2479)', async () => {
    const broadcast = {
      ...baseBroadcast,
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    await svc.refresh('bc-1');

    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    const fetchedAt = upsert.create.fetchedAt as Date;
    const staleAt = upsert.create.staleAt as Date;
    const ttl = staleAt.getTime() - fetchedAt.getTime();
    // Раньше было 24h. После KS-2479 — 5min.
    expect(ttl).toBeLessThan(10 * 60 * 1000);
    expect(ttl).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('internal-fallback unknown (CrosstableLegacy) → TTL по lifecycle (старое поведение)', async () => {
    // Knockout без detect — единственный legit-кейс для unknown.
    // KS-2723: для finished TTL снижен с 24h до 10min (раньше было
    // 24h). Тест поддерживает обновлённый порог.
    const broadcast = {
      ...baseBroadcast,
      format: 'Knockout',
      chessResultsTournamentId: null,
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-1');
    expect(r.tournamentType).toBe('unknown');

    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    const fetchedAt = upsert.create.fetchedAt as Date;
    const staleAt = upsert.create.staleAt as Date;
    const ttl = staleAt.getTime() - fetchedAt.getTime();
    // KS-2723: finished → 10min (было 24h).
    expect(ttl).toBe(10 * 60 * 1000);
  });

  it('chess-results round-robin (sourceType=chess-results) → TTL по lifecycle', async () => {
    // KS-2723: для типизированных chess-results-ответов TTL по
    // lifecycle, finished = 10min (было 24h).
    const html = readFileSync(
      join(FIXTURES_DIR, 'rr-art5-crosstable.html'),
      'utf8',
    );
    const fetchPage = jest.fn().mockResolvedValue(html);
    const fetcher = makeFetcher(fetchPage);
    const prisma = makePrisma({ broadcast: baseBroadcast, lifecycle: 'finished' });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    expect(r.sourceType).toBe('chess-results');

    const upsert = prisma.standingsUpsert.mock.calls[0][0];
    const fetchedAt = upsert.create.fetchedAt as Date;
    const staleAt = upsert.create.staleAt as Date;
    const ttl = staleAt.getTime() - fetchedAt.getTime();
    // KS-2723: chess-results на finished — 10min.
    expect(ttl).toBe(10 * 60 * 1000);
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

  it('swiss format без chess-results-id, пустые игры → roundCount=R, pairings=[]', async () => {
    // Регрессия минимального shape: rounds есть, но без partii — pairings
    // получается пустым (N=0 игроков → 0×R матрица), roundCount=R раундов.
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
    expect(r.roundCount).toBe(1); // baseBroadcast: 1 round, 0 games
    expect(r.pairings).toEqual([]);
  });

  it('KS-2474: swiss без chess-results, есть games → pairings заполнены по турам', async () => {
    // Sardinia-like: трансляция со standingsUrl на vesus.org (не
    // chess-results), partii приходят от Lichess через broadcast_games.
    // Internal-fallback должен собрать pairings[playerIdx][roundIdx]
    // напрямую — иначе фронт рендерит таблицу без колонок R1..RN.
    const broadcast = {
      id: 'bc-sardinia',
      format: '9-round Swiss',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-05-03T13:45:00Z'),
          games: [
            {
              id: 'g-1',
              roundId: 'round-1',
              whitePlayer: 'Svane, Frederik',
              blackPlayer: 'Nepomniachtchi, Ian',
              whiteElo: 2645,
              blackElo: 2729,
              result: '1/2-1/2',
              pgn: null,
            },
            {
              id: 'g-2',
              roundId: 'round-1',
              whitePlayer: 'Jacobson, Brandon',
              blackPlayer: 'Dardha, Daniel',
              whiteElo: 2594,
              blackElo: 2602,
              result: '1-0',
              pgn: null,
            },
          ],
        },
        {
          id: 'round-2',
          name: 'Round 2',
          startsAt: new Date('2026-05-04T13:45:00Z'),
          games: [
            {
              id: 'g-3',
              roundId: 'round-2',
              whitePlayer: 'Nepomniachtchi, Ian',
              blackPlayer: 'Jacobson, Brandon',
              whiteElo: 2729,
              blackElo: 2594,
              result: '1/2-1/2',
              pgn: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-sardinia');

    expect(r.tournamentType).toBe('swiss');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'swiss') return;

    expect(r.roundCount).toBe(2);
    expect(r.players).toHaveLength(4);
    // pairings[playerIdx][roundIdx] для всех 4 игроков, 2 раунда.
    expect(r.pairings).toHaveLength(4);
    expect(r.pairings[0]).toHaveLength(2);

    // Найти Nepomniachtchi (играл оба раунда: ничья в R1 vs Svane,
    // ничья в R2 vs Jacobson).
    const nepo = r.players.find((p) => p.name === 'Nepomniachtchi, Ian');
    expect(nepo).toBeDefined();
    const nepoIdx = r.players.indexOf(nepo!);
    const nepoR1 = r.pairings[nepoIdx][0];
    expect(nepoR1.result).toBe('draw');
    expect(nepoR1.color).toBe('black');
    expect(nepoR1.gameRef?.gameId).toBe('g-1');
    const nepoR2 = r.pairings[nepoIdx][1];
    expect(nepoR2.result).toBe('draw');
    expect(nepoR2.color).toBe('white');
    expect(nepoR2.gameRef?.gameId).toBe('g-3');

    // Jacobson выиграл R1 (white vs Dardha 1-0) и сделал ничью R2 (black).
    const jac = r.players.find((p) => p.name === 'Jacobson, Brandon');
    const jacIdx = r.players.indexOf(jac!);
    expect(r.pairings[jacIdx][0].result).toBe('win');
    expect(r.pairings[jacIdx][0].color).toBe('white');
    expect(r.pairings[jacIdx][0].gameRef?.gameId).toBe('g-2');
    expect(r.pairings[jacIdx][1].result).toBe('draw');
    expect(r.pairings[jacIdx][1].color).toBe('black');

    // Dardha не играл R2 → ячейка пустая (result: null).
    const dardha = r.players.find((p) => p.name === 'Dardha, Daniel');
    const dardhaIdx = r.players.indexOf(dardha!);
    expect(r.pairings[dardhaIdx][0].result).toBe('loss');
    expect(r.pairings[dardhaIdx][1].result).toBeNull();

    // gamesPlayed пересчитан по pairings.
    expect(nepo!.gamesPlayed).toBe(2);
    expect(jac!.gamesPlayed).toBe(2);
    expect(dardha!.gamesPlayed).toBe(1);
  });

  it('KS-2476: double round-robin internal-fallback → cell.games[] с обеими встречами пары', async () => {
    // TCEC-like: 2 движка, 2 раунда (двойной круг).
    // R1: A белыми, win 1-0. R2: B белыми, draw.
    // Ожидаем cell A→B: games=[{white,win},{black,draw}], top-level=last.
    // Cell B→A: games=[{black,loss},{white,draw}].
    const broadcast = {
      id: 'bc-tcec',
      format: '2-engines double round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          games: [
            {
              id: 'g-1',
              roundId: 'round-1',
              whitePlayer: 'Engine A',
              blackPlayer: 'Engine B',
              whiteElo: 3500,
              blackElo: 3500,
              result: '1-0',
              pgn: null,
            },
          ],
        },
        {
          id: 'round-2',
          name: 'Round 2',
          startsAt: new Date('2026-05-01T11:00:00Z'),
          games: [
            {
              id: 'g-2',
              roundId: 'round-2',
              whitePlayer: 'Engine B',
              blackPlayer: 'Engine A',
              whiteElo: 3500,
              blackElo: 3500,
              result: '1/2-1/2',
              pgn: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-tcec');

    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'round-robin') return;

    // После sortCrosstableByPoints: A — points=1.5 (win + draw),
    // B — points=0.5. Должны идти A, B.
    expect(r.players[0].name).toBe('Engine A');
    expect(r.players[1].name).toBe('Engine B');

    // cell A vs B (matrix[0][1])
    const cellAB = r.matrix[0][1];
    expect(cellAB.games).toBeDefined();
    expect(cellAB.games).toHaveLength(2);
    // Первая по startsAt: R1 — A белыми win.
    expect(cellAB.games![0].color).toBe('white');
    expect(cellAB.games![0].result).toBe('win');
    expect(cellAB.games![0].gameRef?.gameId).toBe('g-1');
    // Вторая: R2 — A чёрными draw.
    expect(cellAB.games![1].color).toBe('black');
    expect(cellAB.games![1].result).toBe('draw');
    expect(cellAB.games![1].gameRef?.gameId).toBe('g-2');
    // top-level = последняя.
    expect(cellAB.result).toBe('draw');

    // cell B vs A (matrix[1][0]) — зеркало.
    const cellBA = r.matrix[1][0];
    expect(cellBA.games).toBeDefined();
    expect(cellBA.games).toHaveLength(2);
    expect(cellBA.games![0].color).toBe('black');
    expect(cellBA.games![0].result).toBe('loss');
    expect(cellBA.games![1].color).toBe('white');
    expect(cellBA.games![1].result).toBe('draw');

    // gamesPlayed считает все партии.
    expect(r.players[0].gamesPlayed).toBe(2);
    expect(r.players[1].gamesPlayed).toBe(2);
    expect(r.players[0].points).toBe(1.5);
    expect(r.players[1].points).toBe(0.5);
  });

  it('KS-2564: тайбрейк-раунды (tournamentType=playoff) исключаются из crosstable', async () => {
    // Norway Chess 2026 Carlsen vs Erigaisi: 2 классических раунда +
    // 2 тайбрейка. В круговой таблице — только классика. Детектор
    // (detect-round-tournament-type) проставляет playoff для имени
    // «Tiebreak»/«Armageddon» через STRICT_PLAYOFF_PATTERNS.
    const broadcast = {
      id: 'bc-tiebreak',
      format: '2-player round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'r-classic-1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          tournamentType: 'round_robin',
          games: [
            {
              id: 'g-c1',
              roundId: 'r-classic-1',
              whitePlayer: 'Carlsen',
              blackPlayer: 'Erigaisi',
              whiteElo: 2839,
              blackElo: 2725,
              result: '1/2-1/2',
              pgn: null,
            },
          ],
        },
        {
          id: 'r-classic-2',
          name: 'Round 2',
          startsAt: new Date('2026-05-02T10:00:00Z'),
          tournamentType: 'round_robin',
          games: [
            {
              id: 'g-c2',
              roundId: 'r-classic-2',
              whitePlayer: 'Erigaisi',
              blackPlayer: 'Carlsen',
              whiteElo: 2725,
              blackElo: 2839,
              result: '0-1',
              pgn: null,
            },
          ],
        },
        {
          id: 'r-tiebreak-1',
          name: 'Tiebreak 1',
          startsAt: new Date('2026-05-03T10:00:00Z'),
          tournamentType: 'playoff',
          games: [
            {
              id: 'g-tb1',
              roundId: 'r-tiebreak-1',
              whitePlayer: 'Carlsen',
              blackPlayer: 'Erigaisi',
              whiteElo: 2839,
              blackElo: 2725,
              result: '1-0',
              pgn: null,
            },
          ],
        },
        {
          id: 'r-tiebreak-2',
          name: 'Armageddon',
          startsAt: new Date('2026-05-03T11:00:00Z'),
          tournamentType: 'playoff',
          games: [
            {
              id: 'g-tb2',
              roundId: 'r-tiebreak-2',
              whitePlayer: 'Erigaisi',
              blackPlayer: 'Carlsen',
              whiteElo: 2725,
              blackElo: 2839,
              result: '1-0',
              pgn: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-tiebreak');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;

    expect(r.players[0].name).toBe('Carlsen');
    expect(r.players[1].name).toBe('Erigaisi');

    const cellCE = r.matrix[0][1];
    expect(cellCE.games).toBeDefined();
    expect(cellCE.games).toHaveLength(2);
    const gameIds = cellCE.games!.map((g) => g.gameRef?.gameId);
    expect(gameIds).toContain('g-c1');
    expect(gameIds).toContain('g-c2');
    expect(gameIds).not.toContain('g-tb1');
    expect(gameIds).not.toContain('g-tb2');

    expect(r.players[0].gamesPlayed).toBe(2);
    expect(r.players[1].gamesPlayed).toBe(2);
    expect(r.players[0].points).toBe(1.5);
    expect(r.players[1].points).toBe(0.5);
  });

  it('KS-2564: tournamentType=null (legacy) не фильтруется (back-compat)', async () => {
    // Legacy раунды до KS-1813 без classifier'а — пропускаем.
    const broadcast = {
      id: 'bc-legacy',
      format: '2-player round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'r-legacy',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          tournamentType: null,
          games: [
            {
              id: 'g-legacy',
              roundId: 'r-legacy',
              whitePlayer: 'A',
              blackPlayer: 'B',
              whiteElo: 2000,
              blackElo: 2000,
              result: '1-0',
              pgn: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-legacy');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;
    const cellAB = r.matrix[0][1];
    expect(cellAB.result).toBe('win');
    expect(cellAB.gameRef?.gameId).toBe('g-legacy');
  });

  it('KS-2476: single round-robin не выставляет cell.games (backward-compat)', async () => {
    // 2 игрока, 1 раунд — обычный single-RR. cell.games должно быть
    // undefined, top-level result/gameRef как раньше.
    const broadcast = {
      id: 'bc-single',
      format: '2-player round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          games: [
            {
              id: 'g-1',
              roundId: 'round-1',
              whitePlayer: 'A',
              blackPlayer: 'B',
              whiteElo: 2000,
              blackElo: 2000,
              result: '1-0',
              pgn: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({ broadcast });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher: makeFetcher() });

    const r = await svc.refresh('bc-single');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;
    const cellAB = r.matrix[0][1];
    expect(cellAB.games).toBeUndefined();
    expect(cellAB.result).toBe('win');
    expect(cellAB.gameRef?.gameId).toBe('g-1');
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

/**
 * KS-3658. До правки кросс-таблица круговой схемы оставляла `gameRef`
 * для всех ячеек = null: `buildRoundRobin` опирался ИСКЛЮЧИТЕЛЬНО на
 * ранговый матчинг через `composeGameRefs`, который тихо отбрасывал
 * партии при расхождениях нормализации имён между `chess-results`-
 * таблицей и заголовками `game.whitePlayer/blackPlayer` (lichess).
 *
 * Правка: после рангового матчинга есть резервная схема по нормализованной
 * паре имён (`buildRrGamesByPairMap`). Этот тест воспроизводит сценарий
 * с реальными именами из фикстуры — даже когда есть один путь матчинга,
 * матрица должна содержать `gameRef` для соответствующих ячеек.
 */
describe('BroadcastStandingsSyncService — KS-3658 RR name-based fallback', () => {
  it('round-robin: партии из rounds[].games[] с совпадающими именами → gameRef в ячейках не null', async () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const fetchPage = jest.fn().mockResolvedValue(html);
    const fetcher = makeFetcher(fetchPage);
    // В фикстуре rank=1 — Karunasena A P Chenitha Sihas Dinsara,
    // rank=2 — Dabarera G W D M.
    const broadcastWithGame = {
      ...baseBroadcast,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-04-01T15:00:00Z'),
          games: [
            {
              id: 'game-karu-vs-daba',
              roundId: 'round-1',
              whitePlayer: 'Karunasena, A P Chenitha Sihas Dinsara',
              blackPlayer: 'Dabarera, G W D M',
              whiteElo: null,
              blackElo: null,
            },
          ],
        },
      ],
    };
    const prisma = makePrisma({
      broadcast: broadcastWithGame,
      lifecycle: 'live',
    });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;

    // Находим индексы игроков в матрице по нормализованному имени.
    const idxKaru = r.players.findIndex(
      (p) => p.normalizedName === 'a p chenitha sihas dinsara karunasena',
    );
    const idxDaba = r.players.findIndex(
      (p) => p.normalizedName === 'g w d m dabarera',
    );
    expect(idxKaru).toBeGreaterThanOrEqual(0);
    expect(idxDaba).toBeGreaterThanOrEqual(0);

    // Ячейка Karu vs Daba должна получить gameRef = 'game-karu-vs-daba'.
    const cellKaruVsDaba = r.matrix[idxKaru].find(
      (c) => c.opponentRank === r.players[idxDaba].rank,
    );
    expect(cellKaruVsDaba?.gameRef?.gameId).toBe('game-karu-vs-daba');
    expect(cellKaruVsDaba?.gameRef?.roundId).toBe('round-1');

    // Обратная ячейка тоже должна указывать на ту же партию.
    const cellDabaVsKaru = r.matrix[idxDaba].find(
      (c) => c.opponentRank === r.players[idxKaru].rank,
    );
    expect(cellDabaVsKaru?.gameRef?.gameId).toBe('game-karu-vs-daba');
  });

  it('round-robin: партий нет → gameRef всех ячеек = null (поведение без регрессий)', async () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const fetchPage = jest.fn().mockResolvedValue(html);
    const fetcher = makeFetcher(fetchPage);
    // baseBroadcast уже имеет rounds[0].games = [] → ни один матчинг
    // (ранговый/именной) не найдёт партию. Все gameRef = null.
    const prisma = makePrisma({ broadcast: baseBroadcast, lifecycle: 'live' });
    const redis = makeRedis();
    const svc = makeService({ prisma, redis, fetcher });

    const r = await svc.refresh('bc-1');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;

    // У ячеек без opponentRank/result `gameRef` остаётся undefined
    // (не трогается), у остальных — null (партия не найдена).
    for (const row of r.matrix) {
      for (const cell of row) {
        expect(cell.gameRef ?? null).toBeNull();
      }
    }
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

// ── KS-2214: placeholder не затирает реальный результат в матрице ────────────

describe('KS-2214: round-robin matrix — placeholder не затирает реальный результат', () => {
  /**
   * Воспроизводит ситуацию Sigeman 2026 Round 2:
   *   - В БД 2 записи для одной пары (Grandelius vs Carlsen):
   *     1. Placeholder: result="*" (создан за день до тура)
   *     2. Real game: result="1-0"
   *   - Физический порядок heap в PostgreSQL непредсказуем → Prisma может
   *     вернуть их в любом порядке. Проверяем оба: реальная первая и
   *     реальная вторая — оба должны дать правильный matrix.
   */
  function makeBroadcastWithPlaceholderAndReal(realFirst: boolean) {
    const placeholder = {
      id: 'ph-1',
      roundId: 'round-2',
      whitePlayer: 'Grandelius, Nils',
      blackPlayer: 'Carlsen, Magnus',
      whiteElo: 2620,
      blackElo: 2830,
      result: '*',
      pgn: null,
    };
    const real = {
      id: 'real-1',
      roundId: 'round-2',
      whitePlayer: 'Grandelius, Nils',
      blackPlayer: 'Carlsen, Magnus',
      whiteElo: 2620,
      blackElo: 2830,
      result: '0-1',
      pgn: '[White "Grandelius, Nils"][Black "Carlsen, Magnus"][Result "0-1"]\n\n1. e4 e5 0-1',
    };
    const round1Game = {
      id: 'r1-g1',
      roundId: 'round-1',
      whitePlayer: 'Carlsen, Magnus',
      blackPlayer: 'Abdusattorov, Nodirbek',
      whiteElo: 2830,
      blackElo: 2720,
      result: '1-0',
      pgn: null,
    };
    return {
      id: 'bc-sigeman',
      format: '8-player round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'round-1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T15:00:00Z'),
          games: [round1Game],
        },
        {
          id: 'round-2',
          name: 'Round 2',
          startsAt: new Date('2026-05-02T15:00:00Z'),
          games: realFirst ? [real, placeholder] : [placeholder, real],
        },
      ],
    };
  }

  it('placeholder ПОСЛЕ реальной → результат "0-1" сохраняется (матрица не затирается)', async () => {
    const broadcast = makeBroadcastWithPlaceholderAndReal(true /* real first → placeholder overwrites */);
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher: makeFetcher() });

    const r = await svc.refresh('bc-sigeman');
    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'round-robin') return;

    const carlsen = r.players.find((p) => p.name === 'Carlsen, Magnus');
    const grandelius = r.players.find((p) => p.name === 'Grandelius, Nils');
    expect(carlsen).toBeDefined();
    expect(grandelius).toBeDefined();

    const ci = r.players.indexOf(carlsen!);
    const gi = r.players.indexOf(grandelius!);
    // Carlsen (black) wins → matrix[Carlsen][Grandelius] = 'win'
    expect(r.matrix[ci][gi].result).toBe('win');
    expect(r.matrix[gi][ci].result).toBe('loss');
  });

  it('реальная ПОСЛЕ placeholder → результат "0-1" тоже сохраняется', async () => {
    const broadcast = makeBroadcastWithPlaceholderAndReal(false /* placeholder first → real overwrites */);
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher: makeFetcher() });

    const r = await svc.refresh('bc-sigeman');
    expect(r.tournamentType).toBe('round-robin');
    if (r.tournamentType !== 'round-robin') return;

    const carlsen = r.players.find((p) => p.name === 'Carlsen, Magnus');
    const grandelius = r.players.find((p) => p.name === 'Grandelius, Nils');
    const ci = r.players.indexOf(carlsen!);
    const gi = r.players.indexOf(grandelius!);
    expect(r.matrix[ci][gi].result).toBe('win');
    expect(r.matrix[gi][ci].result).toBe('loss');
  });

  it('gamesPlayed и очки не задваиваются при placeholder + реальная', async () => {
    const broadcast = makeBroadcastWithPlaceholderAndReal(false);
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher: makeFetcher() });

    const r = await svc.refresh('bc-sigeman');
    if (r.tournamentType !== 'round-robin') return;

    const carlsen = r.players.find((p) => p.name === 'Carlsen, Magnus');
    // Round 1 win + Round 2 win = 2 games, 2 points
    expect(carlsen?.gamesPlayed).toBe(2);
    expect(carlsen?.points).toBe(2);
  });
});

describe('BroadcastStandingsSyncService — KS-3266 chess-results title-fallback', () => {
  /**
   * Сценарий Halocher: tnr1349842 от Lichess → «Record not found».
   * Search по title возвращает один кандидат → принимаем без verification,
   * UPDATE'аем broadcast.standings_url и chess_results_tournament_id,
   * retry build на новом id. Ответ — chess-results swiss.
   */
  it('TournamentNotFoundError → single search-кандидат → UPDATE broadcast + retry build', async () => {
    const swissRankingHtml = loadFixture('swiss-art1-ranking.html');
    const swissPairingsHtml = loadFixture('swiss-art2-pairings.html');

    // fetchPage: первый вызов — TournamentNotFoundError, потом — норм HTML.
    const fetchPage = jest
      .fn()
      .mockImplementationOnce(async () => {
        const { TournamentNotFoundError } = await import(
          './chess-results-fetcher'
        );
        throw new TournamentNotFoundError(
          '1349842',
          'https://chess-results.com/tnr1349842.aspx?lan=1&art=1',
        );
      })
      .mockImplementation(async (tid: string, art: number) => {
        if (art === 1) return swissRankingHtml;
        if (art === 2) return swissPairingsHtml;
        return '<html></html>';
      });

    const searchTournamentByTitle = jest.fn().mockResolvedValue([
      { tournamentId: '1422274', title: '39. Internationale Hasslocher Schachtage' },
    ]);
    const fetcher = makeFetcher(fetchPage, searchTournamentByTitle);

    const broadcast = {
      ...baseBroadcast,
      id: 'bc-halocher',
      title: '39. Internationale Haßlocher Schachtage',
      format: 'swiss',
      teamTable: false,
      chessResultsTournamentId: '1349842',
      rounds: [
        {
          id: 'r1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          tournamentType: 'swiss',
          games: [],
        },
      ],
    };

    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher });

    const r = await svc.refresh('bc-halocher');

    // Verify: search был вызван, UPDATE прошёл с новым id, retry build вернул chess-results.
    expect(searchTournamentByTitle).toHaveBeenCalledWith(
      '39. Internationale Haßlocher Schachtage',
    );
    expect(prisma.broadcastUpdate).toHaveBeenCalledWith({
      where: { id: 'bc-halocher' },
      data: {
        chessResultsTournamentId: '1422274',
        standingsUrl: 'https://chess-results.com/tnr1422274.aspx',
      },
    });
    expect(r.sourceType).toBe('chess-results');
    expect(r.tournamentType).toBe('swiss');
    expect(r.sourceUrl).toBe('https://chess-results.com/tnr1422274.aspx');
  });

  it('TournamentNotFoundError → search вернул 0 кандидатов → internal-fallback', async () => {
    const fetchPage = jest.fn().mockImplementation(async () => {
      const { TournamentNotFoundError } = await import(
        './chess-results-fetcher'
      );
      throw new TournamentNotFoundError(
        '999999',
        'https://chess-results.com/tnr999999.aspx?lan=1&art=1',
      );
    });
    const searchTournamentByTitle = jest.fn().mockResolvedValue([]);
    const fetcher = makeFetcher(fetchPage, searchTournamentByTitle);

    const broadcast = {
      ...baseBroadcast,
      id: 'bc-notfound',
      title: 'Unknown Tournament XYZ',
      format: 'swiss',
      chessResultsTournamentId: '999999',
      rounds: [{ id: 'r1', name: 'R1', startsAt: null, tournamentType: 'swiss', games: [] }],
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher });

    const r = await svc.refresh('bc-notfound');

    expect(searchTournamentByTitle).toHaveBeenCalled();
    // Broadcast НЕ должен быть UPDATE'нут — кандидатов не нашли.
    expect(prisma.broadcastUpdate).not.toHaveBeenCalled();
    // Падаем на internal-fallback.
    expect(r.sourceType).toBe('internal-fallback');
  });

  it('TournamentNotFoundError → multi-кандидаты, нет players в broadcast_games → skip (без подмены)', async () => {
    const fetchPage = jest.fn().mockImplementation(async () => {
      const { TournamentNotFoundError } = await import(
        './chess-results-fetcher'
      );
      throw new TournamentNotFoundError(
        '111111',
        'https://chess-results.com/tnr111111.aspx?lan=1&art=1',
      );
    });
    const searchTournamentByTitle = jest.fn().mockResolvedValue([
      { tournamentId: '222222', title: 'Tournament A 2026' },
      { tournamentId: '333333', title: 'Tournament A 2025' },
      { tournamentId: '444444', title: 'Tournament A 2024' },
    ]);
    const fetcher = makeFetcher(fetchPage, searchTournamentByTitle);

    const broadcast = {
      ...baseBroadcast,
      id: 'bc-multi',
      title: 'Tournament A',
      format: 'swiss',
      chessResultsTournamentId: '111111',
      rounds: [{ id: 'r1', name: 'R1', startsAt: null, tournamentType: 'swiss', games: [] }],
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher });

    const r = await svc.refresh('bc-multi');

    // Ни verify-fetch'ей, ни UPDATE — нечем верифицировать.
    expect(prisma.broadcastUpdate).not.toHaveBeenCalled();
    expect(r.sourceType).toBe('internal-fallback');
  });

  it('TournamentNotFoundError → multi-кандидаты, верификация прошла на первом', async () => {
    const swissRankingHtml = loadFixture('swiss-art1-ranking.html');
    const swissPairingsHtml = loadFixture('swiss-art2-pairings.html');

    // 1. Первый fetchPage (originalTid, art=1) — NotFound.
    // 2-N. После title-search + UPDATE — обычные art=1/art=2 для нового tid.
    //      Для верификации (counts player overlap) — fetchPage(tnr=222222, art=1) → swiss-art1-ranking.
    let firstCalled = false;
    const fetchPage = jest.fn().mockImplementation(
      async (tid: string, art: number) => {
        if (!firstCalled) {
          firstCalled = true;
          const { TournamentNotFoundError } = await import(
            './chess-results-fetcher'
          );
          throw new TournamentNotFoundError(
            String(tid),
            `https://chess-results.com/tnr${tid}.aspx?lan=1&art=${art}`,
          );
        }
        if (art === 1) return swissRankingHtml;
        if (art === 2) return swissPairingsHtml;
        return '<html></html>';
      },
    );
    const searchTournamentByTitle = jest.fn().mockResolvedValue([
      { tournamentId: '222222', title: 'Real Match' },
      { tournamentId: '333333', title: 'Other Match' },
    ]);
    const fetcher = makeFetcher(fetchPage, searchTournamentByTitle);

    // Игроки из swiss-art1-ranking.html фикстуры — берём первые имена.
    // Чтобы countPlayerOverlap нашёл ≥3 общих имён, broadcast_games
    // содержат тех же игроков.
    // Простые имена из реальной chess-results swiss-ranking фикстуры:
    const fixturePlayerNames = extractTopNamesFromSwissRanking(swissRankingHtml, 5);
    expect(fixturePlayerNames.length).toBeGreaterThanOrEqual(3);

    const broadcast = {
      ...baseBroadcast,
      id: 'bc-verify',
      title: 'Tournament X',
      format: 'swiss',
      chessResultsTournamentId: '111111',
      rounds: [
        {
          id: 'r1',
          name: 'Round 1',
          startsAt: new Date('2026-05-01T10:00:00Z'),
          tournamentType: 'swiss',
          games: fixturePlayerNames.slice(0, 3).map((n, i) => ({
            id: `g-${i}`,
            roundId: 'r1',
            whitePlayer: n,
            blackPlayer: fixturePlayerNames[(i + 1) % fixturePlayerNames.length],
            whiteElo: null,
            blackElo: null,
            result: '1-0',
            pgn: null,
          })),
        },
      ],
    };
    const prisma = makePrisma({ broadcast, lifecycle: 'finished' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher });

    const r = await svc.refresh('bc-verify');

    expect(prisma.broadcastUpdate).toHaveBeenCalledWith({
      where: { id: 'bc-verify' },
      data: {
        chessResultsTournamentId: '222222',
        standingsUrl: 'https://chess-results.com/tnr222222.aspx',
      },
    });
    expect(r.sourceType).toBe('chess-results');
  });

  it('не-NotFound ошибка fetcher → НЕ запускает title-search, прямой internal-fallback', async () => {
    const fetchPage = jest
      .fn()
      .mockRejectedValue(new Error('upstream 500'));
    const searchTournamentByTitle = jest.fn();
    const fetcher = makeFetcher(fetchPage, searchTournamentByTitle);

    const broadcast = {
      ...baseBroadcast,
      title: 'Some Tournament',
      format: 'swiss',
      chessResultsTournamentId: '123',
      rounds: [{ id: 'r1', name: 'R1', startsAt: null, tournamentType: 'swiss', games: [] }],
    };
    const prisma = makePrisma({ broadcast });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher });

    const r = await svc.refresh('bc-1');

    expect(searchTournamentByTitle).not.toHaveBeenCalled();
    expect(prisma.broadcastUpdate).not.toHaveBeenCalled();
    expect(r.sourceType).toBe('internal-fallback');
  });
});

/**
 * Хелпер для KS-3266 теста: извлекает имена топ-N игроков из HTML
 * swiss-art1-ranking фикстуры (table → first column with players).
 * Простая parsable structure: ищем строки таблицы, в которых есть
 * link на player-profile, и берём текст из соседней колонки.
 */
function extractTopNamesFromSwissRanking(html: string, n: number): string[] {
  const names: string[] = [];
  // Ищем `<td>...</td>` блоки в строке игрока. Дёшево и сердито —
  // chess-results ranking-table обычно структурирована как
  // `<tr class="CRng1/CRng2"><td>rank</td>...<td>Name</td>...</tr>`.
  const rowRe = /<tr[^>]*class="CRn[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null && names.length < n) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    // Имя обычно во 2-3 колонке (после rank/title или start-no).
    const candidate = cells.find(
      (c) => /[A-Za-zА-Яа-я]/.test(c) && c.length >= 4 && !/^\d+$/.test(c),
    );
    if (candidate) names.push(candidate);
  }
  return names;
}

describe('KS-3529: double-RR — placeholder будущего round не обнуляет top-level result', () => {
  /**
   * Воспроизводит Norway Chess 2026 Open после Round 5 / Round 6 ongoing:
   *   - Пара Firouzja vs Carlsen (rank 1 vs 6): Round 1 real (1-0)
   *     + Round 6 placeholder (result='*', ongoing).
   *   - Bug: builder сортировал cleaned по startsAt asc → last = round 6
   *     placeholder → top-level result/gameRef обнулялись. Фронт читал
   *     top-level → клетка пустая, хотя r1 в БД был.
   * Fix: top-level берётся из ПОСЛЕДНЕГО реального (isReal=true) entry.
   */
  function norwayBroadcast() {
    return {
      id: 'bc-norway',
      format: '6-player double round-robin',
      teamTable: false,
      chessResultsTournamentId: null,
      rounds: [
        {
          id: 'r1',
          name: 'Round 1',
          startsAt: new Date('2026-05-25T15:00:00Z'),
          games: [
            {
              id: 'r1-fc',
              roundId: 'r1',
              whitePlayer: 'Firouzja, Alireza',
              blackPlayer: 'Carlsen, Magnus',
              whiteElo: 2780,
              blackElo: 2830,
              result: '1-0',
              pgn: null,
            },
          ],
        },
        {
          id: 'r6',
          name: 'Round 6',
          startsAt: new Date('2026-05-31T15:00:00Z'),
          games: [
            // Placeholder для второго круга (reversed colors)
            {
              id: 'r6-cf',
              roundId: 'r6',
              whitePlayer: 'Carlsen, Magnus',
              blackPlayer: 'Firouzja, Alireza',
              whiteElo: 2830,
              blackElo: 2780,
              result: '*',
              pgn: null,
            },
          ],
        },
      ],
    };
  }

  it('top-level result/gameRef отражают реальный r1, не placeholder r6', async () => {
    const broadcast = norwayBroadcast();
    const prisma = makePrisma({ broadcast, lifecycle: 'live' });
    const svc = makeService({ prisma, redis: makeRedis(), fetcher: makeFetcher() });

    const r = await svc.refresh('bc-norway');
    expect(r.tournamentType).toBe('round-robin');
    expect(r.sourceType).toBe('internal-fallback');
    if (r.tournamentType !== 'round-robin') return;

    const firouzja = r.players.find((p) => p.name === 'Firouzja, Alireza');
    const carlsen = r.players.find((p) => p.name === 'Carlsen, Magnus');
    expect(firouzja).toBeDefined();
    expect(carlsen).toBeDefined();

    const fi = r.players.indexOf(firouzja!);
    const ci = r.players.indexOf(carlsen!);

    // Top-level: Firouzja vs Carlsen = win (r1 result), не null.
    expect(r.matrix[fi][ci].result).toBe('win');
    expect(r.matrix[fi][ci].gameRef).not.toBeNull();
    expect(r.matrix[fi][ci].gameRef?.roundName).toBe('Round 1');
    // Симметрично: Carlsen vs Firouzja = loss.
    expect(r.matrix[ci][fi].result).toBe('loss');
    expect(r.matrix[ci][fi].gameRef?.roundName).toBe('Round 1');

    // games[] обёртка тоже должна быть (2 встречи: r1 real + r6 placeholder).
    expect(r.matrix[fi][ci].games?.length).toBe(2);
    // Первый элемент — r1 (по startsAt asc), второй — r6 placeholder.
    expect(r.matrix[fi][ci].games?.[0].result).toBe('win');
    expect(r.matrix[fi][ci].games?.[1].result).toBeNull();
  });
});
