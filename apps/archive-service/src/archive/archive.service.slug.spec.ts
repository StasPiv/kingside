/**
 * KS-2074 — `ArchiveService.getGameById` подтягивает slug из
 * archive_players + fallback через archiveSlug при отсутствии записи.
 */
import type {
  ArchiveBucket,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveMetricsService } from './archive-metrics.service';
import {
  ArchiveStatsRepository,
  GamesByPositionOpts,
  GamesByPositionPage,
  RawArchiveGameRow,
  SearchGamesOpts,
  SearchGamesPage,
  SearchPlayerGamesOpts,
  SearchPlayerGamesPage,
  TreeOpts,
} from './archive-stats.repository';

class FakeRedis {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<'OK'> { return 'OK'; }
  async keys(): Promise<string[]> { return []; }
  async del(): Promise<number> { return 0; }
  duplicate(): FakeRedis { return this; }
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async quit(): Promise<void> {}
  on(): void {}
}

class StubRepo implements ArchiveStatsRepository {
  async getTree(_p: Buffer, _o: TreeOpts): Promise<ArchiveTreeResponse> { throw new Error('nu'); }
  async getGamesByPosition(_p: Buffer, _o: GamesByPositionOpts): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_p: Buffer, _b: ArchiveBucket): Promise<number> { return 0; }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> { return []; }
  async searchGames(_o: SearchGamesOpts): Promise<SearchGamesPage> {
    return { total: 0, items: [] as RawArchiveGameRow[] };
  }
  async searchPlayers() { return { total: 0, items: [] as never[] }; }
  async searchEvents() { return { total: 0, items: [] as never[] }; }
  async getPlayerProfile() { return null; }
  async searchPlayerGames(_o: SearchPlayerGamesOpts): Promise<SearchPlayerGamesPage> {
    return { total: 0, items: [] };
  }
}

function makeService(prisma: unknown): ArchiveService {
  return new ArchiveService(
    prisma as never,
    new FakeRedis() as never,
    new ArchiveMetricsService(),
    new StubRepo(),
  );
}

interface FakeGame {
  id: string;
  event: string | null;
  site: string | null;
  round: string | null;
  date: string | null;
  playedAt: Date | null;
  whiteName: string | null;
  blackName: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  whiteTitle: string | null;
  blackTitle: string | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  plyCount: number | null;
  pgn: string;
}

function fakePrisma(opts: {
  game: FakeGame | null;
  slugLookup: Array<{ name_canonical: string; slug: string }>;
}) {
  return {
    archiveGame: {
      findUnique: jest.fn().mockResolvedValue(opts.game),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue(opts.slugLookup),
  };
}

describe('ArchiveService.getGameById — KS-2074 slug resolve', () => {
  const baseGame: FakeGame = {
    id: 'g1',
    event: 'Test',
    site: null,
    round: null,
    date: null,
    playedAt: new Date('2026-01-01'),
    whiteName: 'Carlsen, Magnus',
    blackName: 'Tezka, A.',
    whiteElo: 2830,
    blackElo: 2400,
    whiteTitle: 'GM',
    blackTitle: 'IM',
    result: '1-0',
    eco: 'B90',
    opening: null,
    plyCount: 50,
    pgn: '1. e4',
  };

  it('берёт slug из БД для известных игроков (поддерживает тёзок с числовым суффиксом)', async () => {
    const prisma = fakePrisma({
      game: baseGame,
      slugLookup: [
        { name_canonical: 'Carlsen, Magnus', slug: 'carlsen-magnus' },
        { name_canonical: 'Tezka, A.', slug: 'tezka-a-2' }, // тёзка
      ],
    });
    const svc = makeService(prisma);
    const detail = await svc.getGameById('g1');

    expect(detail.white.slug).toBe('carlsen-magnus');
    expect(detail.black.slug).toBe('tezka-a-2');
  });

  it('fallback на archiveSlug когда игрок ещё не в archive_players', async () => {
    const prisma = fakePrisma({
      game: baseGame,
      slugLookup: [], // никого нет в archive_players
    });
    const svc = makeService(prisma);
    const detail = await svc.getGameById('g1');

    expect(detail.white.slug).toBe('carlsen-magnus');
    expect(detail.black.slug).toBe('tezka-a');
  });

  it('пустой name → slug=""', async () => {
    const prisma = fakePrisma({
      game: { ...baseGame, whiteName: null, blackName: null },
      slugLookup: [],
    });
    const svc = makeService(prisma);
    const detail = await svc.getGameById('g1');

    expect(detail.white.slug).toBe('');
    expect(detail.black.slug).toBe('');
  });

  it('батч-lookup вызывается одним запросом с уникальными именами', async () => {
    const prisma = fakePrisma({
      game: { ...baseGame, whiteName: 'Same', blackName: 'Same' },
      slugLookup: [{ name_canonical: 'Same', slug: 'same-2' }],
    });
    const svc = makeService(prisma);
    await svc.getGameById('g1');

    // $queryRawUnsafe вызвался один раз с одним уникальным именем.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const call = prisma.$queryRawUnsafe.mock.calls[0];
    expect(call[1]).toEqual(['Same']);
  });

  it('404 когда партии нет', async () => {
    const prisma = fakePrisma({ game: null, slugLookup: [] });
    const svc = makeService(prisma);
    await expect(svc.getGameById('nope')).rejects.toThrow();
  });
});
