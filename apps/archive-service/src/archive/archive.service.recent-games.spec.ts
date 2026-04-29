/**
 * KS-2090 — кэш и skipTotal для clean-recent-режима `getGames`.
 *
 * Проверки:
 *   - sort=recent + offset=0 + нет фильтров → opts.skipTotal=true,
 *     total в ответе = items.length, COUNT(*) не делается;
 *   - первый вызов кладёт в Redis arch:games:recent:<limit>;
 *   - второй вызов с тем же limit — cache hit, repo не дёргается;
 *   - sort=topElo / offset>0 / любой фильтр → старая логика (skipTotal=false);
 *   - prewarmRecentGames прогоняет getGames({}) и кладёт в кэш.
 */
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
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string): Promise<'OK'> { this.store.set(key, value); return 'OK'; }
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
  public lastSearchGamesOpts: SearchGamesOpts | null = null;
  public searchGamesCalls = 0;

  async getTree(_p: Buffer, _o: TreeOpts): Promise<ArchiveTreeResponse> {
    throw new Error('not used');
  }
  async getGamesByPosition(_p: Buffer, _o: GamesByPositionOpts): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_p: Buffer, _b: ArchiveBucket): Promise<number> { return 0; }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> { return []; }
  async searchGames(opts: SearchGamesOpts): Promise<SearchGamesPage> {
    this.lastSearchGamesOpts = opts;
    this.searchGamesCalls += 1;
    const row: RawArchiveGameRow = {
      id: 'g1',
      event: null,
      site: null,
      round: null,
      date: null,
      played_at: new Date('2026-01-01'),
      white_name: 'A',
      black_name: 'B',
      white_elo: 2700,
      black_elo: 2650,
      white_title: null,
      black_title: null,
      result: '1-0',
      eco: null,
      opening: null,
      ply_count: 40,
      white_slug: null,
      black_slug: null,
    };
    return { total: 1, hasNext: false, items: [row] };
  }
  async searchPlayers() { return { total: 0, items: [] as never[] }; }
  async searchEvents() { return { total: 0, items: [] as never[] }; }
  async getPlayerProfile() { return null; }
  async searchPlayerGames(_o: SearchPlayerGamesOpts): Promise<SearchPlayerGamesPage> {
    return { total: 0, hasNext: false, items: [] };
  }
}

function makeService(repo: CapturingRepo): { svc: ArchiveService; redis: FakeRedis } {
  const prisma = {} as never;
  const redis = new FakeRedis();
  const metrics = new ArchiveMetricsService();
  return { svc: new ArchiveService(prisma, redis as never, metrics, repo), redis };
}

describe('ArchiveService.getGames recent-cache — KS-2090', () => {
  it('clean-recent (default request) → skipTotal=true, total=null (KS-2140), COUNT не делается', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);

    const res = await svc.getGames({});

    expect(repo.lastSearchGamesOpts?.skipTotal).toBe(true);
    expect(repo.lastSearchGamesOpts?.sort).toBe('recent');
    // KS-2140: total = null (явный контракт «не считали»). Пагинация
    // через hasNext.
    expect(res.total).toBeNull();
    expect(typeof res.hasNext).toBe('boolean');
    expect(res.items).toHaveLength(1);
  });

  it('первый вызов кладёт в Redis arch:games:recent:<limit>; второй — cache hit', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.getGames({ limit: 10 });
    await svc.getGames({ limit: 10 });

    // Repo дёрнулся ровно один раз — второй ответ из Redis.
    expect(repo.searchGamesCalls).toBe(1);
    expect([...redis.store.keys()]).toContain('arch:games:recent:10');
  });

  it('разные limit → разные cache-keys', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.getGames({ limit: 10 });
    await svc.getGames({ limit: 20 });

    expect(repo.searchGamesCalls).toBe(2);
    expect([...redis.store.keys()]).toEqual(
      expect.arrayContaining(['arch:games:recent:10', 'arch:games:recent:20']),
    );
  });

  it('sort=topElo → НЕ clean-recent: skipTotal=true (KS-2140), кэш не используется', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.getGames({ sort: 'topElo' });
    await svc.getGames({ sort: 'topElo' });

    // Каждый вызов идёт в repo (без кэша на topElo).
    expect(repo.searchGamesCalls).toBe(2);
    // KS-2140: skipTotal теперь авто-true для любых не-clean-recent
    // запросов — COUNT(*) на 760 МБ heap идёт Parallel Seq Scan.
    expect(repo.lastSearchGamesOpts?.skipTotal).toBe(true);
    // Ключ recent в Redis не появлялся.
    expect([...redis.store.keys()].filter((k) => k.startsWith('arch:games:recent:'))).toHaveLength(0);
  });

  it.each([
    ['offset', { offset: 50 }],
    ['eco', { eco: 'B90' }],
    ['player строка', { player: 'Carlsen' }],
    ['player массив', { player: ['Carlsen'] }],
    ['white', { white: 'Carlsen' }],
    ['black', { black: 'Carlsen' }],
    ['event', { event: 'Tata' }],
    ['result', { result: '1-0' as const }],
    ['since', { since: '2020-01-01T00:00:00Z' }],
    ['until', { until: '2024-01-01T00:00:00Z' }],
    ['minElo', { minElo: 2700 }],
    ['minPly', { minPly: 30 }],
    ['maxPly', { maxPly: 80 }],
    ['fen', { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }],
    ['move', { move: 'e2e4' }],
  ])('фильтр %s → НЕ clean-recent, skipTotal=true (KS-2140)', async (_name, req) => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await svc.getGames(req);
    // KS-2140: для любых запросов с фильтрами / non-recent / offset>0
    // backend сам выставляет skipTotal=true. Раньше тут было false и
    // COUNT(*) шёл Parallel Seq Scan на 5-6 сек.
    expect(repo.lastSearchGamesOpts?.skipTotal).toBe(true);
  });

  it('player=[] (пустой массив) → считается отсутствием фильтра, clean-recent', async () => {
    const repo = new CapturingRepo();
    const { svc } = makeService(repo);
    await svc.getGames({ player: [] });
    expect(repo.lastSearchGamesOpts?.skipTotal).toBe(true);
  });

  it('prewarmRecentGames вызывает getGames и кладёт в кэш', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    await svc.prewarmRecentGames();

    expect(repo.searchGamesCalls).toBe(1);
    expect([...redis.store.keys()]).toContain('arch:games:recent:50');
  });

  it('KS-2146-2: cursor → НЕ clean-recent (не отдаём cached page1, иначе зацикливание)', async () => {
    const repo = new CapturingRepo();
    const { svc, redis } = makeService(repo);

    // Сначала прогреем кэш чистым recent-запросом.
    await svc.getGames({});
    expect([...redis.store.keys()]).toContain('arch:games:recent:50');
    expect(repo.searchGamesCalls).toBe(1);

    // Теперь запрос с cursor — раньше попадал в cache-path и отдавал
    // cached первую страницу с тем же nextCursor → зацикливание архива
    // на проде (devops зафиксировал 30 страниц × 20 items = 580 дублей).
    const result = await svc.getGames({
      cursor: 'eyJ0IjoiMjAyNi0wNC0yN1QwMDowMDowMC4wMDBaIiwiZyI6ImFiYyJ9',
    });
    // Новый репо-вызов (cache miss → keyset query).
    expect(repo.searchGamesCalls).toBe(2);
    // С cursor backend передаёт его в opts (раньше нет).
    expect(repo.lastSearchGamesOpts?.cursor).toBeDefined();
    // skipTotal=true как для всех не-clean-recent.
    expect(repo.lastSearchGamesOpts?.skipTotal).toBe(true);
    expect(result.total).toBeNull();
  });
});
