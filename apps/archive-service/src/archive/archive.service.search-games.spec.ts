/**
 * KS-2063 — `ArchiveService.getGames` (metadata-list).
 *
 * Проверяется делегирование в `ArchiveStatsRepository.searchGames` с
 * правильно проброшенными фильтрами/сортировкой и валидация:
 *   - offset > 5000 → BadRequestException;
 *   - minPly > maxPly → BadRequestException;
 *   - default sort = 'recent'.
 */
import { BadRequestException } from '@nestjs/common';
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

class CapturingRepo implements ArchiveStatsRepository {
  public lastSearchOpts: SearchGamesOpts | null = null;

  async getTree(_posKey: Buffer, _opts: TreeOpts): Promise<ArchiveTreeResponse> {
    throw new Error('not used');
  }
  async getGamesByPosition(
    _posKey: Buffer,
    _opts: GamesByPositionOpts,
  ): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_posKey: Buffer, _bucket: ArchiveBucket): Promise<number> {
    return 0;
  }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> {
    return [];
  }
  async searchPlayers(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
  async searchEvents(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
  async getPlayerProfile(): Promise<null> {
    return null;
  }
  async searchPlayerGames(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
  async searchGames(opts: SearchGamesOpts): Promise<SearchGamesPage> {
    this.lastSearchOpts = opts;
    const row: RawArchiveGameRow = {
      id: 'g1',
      event: 'Test',
      site: null,
      round: null,
      date: null,
      played_at: new Date('2026-04-01T00:00:00Z'),
      white_name: 'A',
      black_name: 'B',
      white_elo: 2700,
      black_elo: 2650,
      white_title: null,
      black_title: null,
      result: '1-0',
      eco: 'C50',
      opening: null,
      ply_count: 40,
    };
    return { total: 1, items: [row] };
  }
}

function makeService(repo: CapturingRepo): ArchiveService {
  const prisma = {} as never;
  const redis = new FakeRedis();
  const metrics = new ArchiveMetricsService();
  return new ArchiveService(prisma, redis as never, metrics, repo);
}

describe('ArchiveService.getGames — KS-2063', () => {
  it('default sort = recent', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    await svc.getGames({});

    expect(repo.lastSearchOpts?.sort).toBe('recent');
  });

  it('пробрасывает все новые фильтры в repo', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    await svc.getGames({
      until: '2026-12-31T23:59:59Z',
      event: 'Tata',
      minPly: 20,
      maxPly: 100,
      sort: 'topElo',
      eco: 'B90',
      player: 'Carlsen',
      since: '2020-01-01T00:00:00Z',
      minElo: 2700,
      result: '1-0',
      limit: 25,
      offset: 50,
    });

    const opts = repo.lastSearchOpts!;
    expect(opts.event).toBe('Tata');
    expect(opts.minPly).toBe(20);
    expect(opts.maxPly).toBe(100);
    expect(opts.sort).toBe('topElo');
    expect(opts.eco).toBe('B90');
    expect(opts.player).toBe('Carlsen');
    expect(opts.minElo).toBe(2700);
    expect(opts.result).toBe('1-0');
    expect(opts.limit).toBe(25);
    expect(opts.offset).toBe(50);
    expect(opts.since).toBeInstanceOf(Date);
    expect(opts.until).toBeInstanceOf(Date);
    expect(opts.until?.toISOString()).toBe('2026-12-31T23:59:59.000Z');
  });

  it('offset > 5000 → BadRequestException', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    await expect(svc.getGames({ offset: 5001 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.lastSearchOpts).toBeNull();
  });

  it('offset = 5000 — допустимо', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    await svc.getGames({ offset: 5000 });
    expect(repo.lastSearchOpts?.offset).toBe(5000);
  });

  it('minPly > maxPly → BadRequestException', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    await expect(svc.getGames({ minPly: 80, maxPly: 20 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('маппит RawArchiveGameRow в ArchiveGameSummary с canonical date из played_at', async () => {
    const repo = new CapturingRepo();
    const svc = makeService(repo);

    const res = await svc.getGames({});

    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('g1');
    expect(res.items[0].white).toEqual({ name: 'A', slug: 'a', elo: 2700, title: null });
    expect(res.items[0].black).toEqual({ name: 'B', slug: 'b', elo: 2650, title: null });
    expect(res.items[0].date).toBe('2026-04-01T00:00:00.000Z');
    expect(res.items[0].plyCount).toBe(40);
  });
});
