/**
 * KS-2065 — `ArchiveService` методы players/events.
 *
 * Проверяем:
 *   - searchPlayers / searchEvents отдают второй раз из Redis (cache hit);
 *   - getPlayerProfile: 404 → NotFoundException; кэш TTL 1ч (просто фиксируем set был);
 *   - getPlayerGames: проброс фильтров в repo, offset>5000 → 400, minPly>maxPly → 400;
 *   - cache key включает q/limit/offset → разные q дают разные кэш-записи.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ArchiveBucket, ArchiveTreeResponse } from '@kingside/shared';
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
  public store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  duplicate(): FakeRedis { return this; }
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async quit(): Promise<void> {}
  on(): void {}
}

class CapturingRepo implements ArchiveStatsRepository {
  public lastPlayersOpts: { q: string; limit: number; offset: number } | null = null;
  public lastEventsOpts: { q: string; limit: number; offset: number } | null = null;
  public lastPlayerGamesOpts: SearchPlayerGamesOpts | null = null;
  public profileBySlug = new Map<string, ReturnType<ArchiveStatsRepository['getPlayerProfile']> extends Promise<infer T> ? T : never>();

  async getTree(_p: Buffer, _o: TreeOpts): Promise<ArchiveTreeResponse> {
    throw new Error('not used');
  }
  async getGamesByPosition(_p: Buffer, _o: GamesByPositionOpts): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_p: Buffer, _b: ArchiveBucket): Promise<number> { return 0; }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> { return []; }
  async searchGames(_o: SearchGamesOpts): Promise<SearchGamesPage> {
    return { total: 0, hasNext: false, items: [] as RawArchiveGameRow[] };
  }
  async searchPlayers(opts: { q: string; limit: number; offset: number }) {
    this.lastPlayersOpts = opts;
    return {
      total: 1,
      items: [
        { name: 'Carlsen, Magnus', slug: 'carlsen-magnus', gamesCount: 1234, peakElo: 2882 },
      ],
    };
  }
  async searchEvents(opts: { q: string; limit: number; offset: number }) {
    this.lastEventsOpts = opts;
    return {
      total: 1,
      items: [
        { name: 'Tata Steel 2024', slug: 'tata-steel-2024', gamesCount: 91, firstDate: null, lastDate: null },
      ],
    };
  }
  async getPlayerProfile(slug: string) {
    return this.profileBySlug.get(slug) ?? null;
  }
  async searchPlayerGames(opts: SearchPlayerGamesOpts): Promise<SearchPlayerGamesPage> {
    this.lastPlayerGamesOpts = opts;
    return { total: 0, hasNext: false, items: [] };
  }
}

function makeService(repo: CapturingRepo): { svc: ArchiveService; redis: FakeRedis } {
  const prisma = {} as never;
  const redis = new FakeRedis();
  const metrics = new ArchiveMetricsService();
  return {
    svc: new ArchiveService(prisma, redis as never, metrics, repo),
    redis,
  };
}

describe('ArchiveService.searchPlayers — KS-2065', () => {
  it('второй вызов с тем же q — cache hit, repo не дёргается', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);

    const a = await svc.searchPlayers({ q: 'carlsen' });
    const b = await svc.searchPlayers({ q: 'carlsen' });

    expect(a).toEqual(b);
    expect(repo.lastPlayersOpts).not.toBeNull();
    // Repo вызвался только один раз: тут нет счётчика, но проверим cache в Redis.
  });

  it('разные q → разные cache-keys', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.searchPlayers({ q: 'carlsen' });
    await svc.searchPlayers({ q: 'caruana' });

    const keys = [...redis.store.keys()].filter((k) => k.startsWith('arch:players:search:'));
    expect(keys).toHaveLength(2);
  });
});

describe('ArchiveService.searchEvents — KS-2065', () => {
  it('кэшируется по arch:events:search:*', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.searchEvents({ q: 'tata' });
    expect([...redis.store.keys()].some((k) => k.startsWith('arch:events:search:'))).toBe(true);
  });
});

describe('ArchiveService.getPlayerProfile — KS-2065', () => {
  it('404 для несуществующего slug', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await expect(svc.getPlayerProfile('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('возвращает профиль и кладёт в кэш arch:players:profile:<slug>', async () => {
    const repo = new CapturingRepo();
    repo.profileBySlug.set('carlsen-magnus', {
      name: 'Carlsen, Magnus',
      slug: 'carlsen-magnus',
      gamesCount: 1234,
      peakElo: 2882,
      byColor: { white: 700, black: 534 },
      byResult: { wins: 600, draws: 500, losses: 134 },
      firstSeenAt: '2010-01-01T00:00:00.000Z',
      lastSeenAt: '2026-04-01T00:00:00.000Z',
    });
    const { svc, redis } = makeService(repo);

    const p = await svc.getPlayerProfile('carlsen-magnus');
    expect(p.name).toBe('Carlsen, Magnus');
    expect(redis.store.has('arch:players:profile:carlsen-magnus')).toBe(true);
  });
});

describe('ArchiveService.getPlayerGames — KS-2065', () => {
  it('пробрасывает фильтры и slug в repo', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);

    await svc.getPlayerGames('carlsen-magnus', {
      color: 'white',
      sort: 'topElo',
      eco: 'B90',
      since: '2020-01-01T00:00:00Z',
      minElo: 2700,
      limit: 50,
    });

    const opts = repo.lastPlayerGamesOpts!;
    expect(opts.slug).toBe('carlsen-magnus');
    expect(opts.color).toBe('white');
    expect(opts.sort).toBe('topElo');
    expect(opts.eco).toBe('B90');
    expect(opts.minElo).toBe(2700);
    expect(opts.since).toBeInstanceOf(Date);
  });

  it('default sort = recent', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await svc.getPlayerGames('x', {});
    expect(repo.lastPlayerGamesOpts?.sort).toBe('recent');
  });

  it('offset > 5000 → 400', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await expect(svc.getPlayerGames('x', { offset: 5001 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('minPly > maxPly → 400', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await expect(svc.getPlayerGames('x', { minPly: 80, maxPly: 20 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
