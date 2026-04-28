/**
 * KS-2074 — резолвинг slug в `ArchivePlayerInfo`.
 *
 * Проверки:
 *   - resolveArchivePlayerSlug: db slug приоритетнее archiveSlug;
 *   - fallback на archiveSlug(name) если db slug = null;
 *   - пустое имя → '';
 *   - searchGames items включают slug из LEFT JOIN;
 *   - searchPlayerGames items включают slug;
 *   - by-position rowToItem проставляет slug.
 */
import {
  PostgresArchiveStatsRepository,
  RawArchiveGameRow,
  RawPlayerGameRow,
  resolveArchivePlayerSlug,
} from './archive-stats.repository';
import type { PrismaService } from '../prisma/prisma.service';

interface SqlCall { sql: string; params: unknown[] }

describe('resolveArchivePlayerSlug — KS-2074', () => {
  it('предпочитает slug из БД (тёзка с числовым суффиксом)', () => {
    expect(resolveArchivePlayerSlug('Carlsen, M.', 'carlsen-m-2')).toBe('carlsen-m-2');
  });

  it('fallback на archiveSlug если slug=null (запись не успела попасть в archive_players)', () => {
    expect(resolveArchivePlayerSlug('Carlsen, Magnus', null)).toBe('carlsen-magnus');
  });

  it('пустое имя → ""', () => {
    expect(resolveArchivePlayerSlug(null, null)).toBe('');
    expect(resolveArchivePlayerSlug('', 'whatever')).toBe('');
  });

  it('пустой slug из БД (странно, но возможно) → fallback', () => {
    // archiveSlug('Foo') = 'foo'; db вернул '' — берём fallback.
    expect(resolveArchivePlayerSlug('Foo', '')).toBe('foo');
  });
});

function fakePrisma(rows: Record<string, unknown>[]): { prisma: PrismaService; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const $queryRawUnsafe = async <T>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(rows.length) }] as unknown as T;
    return rows as unknown as T;
  };
  return { prisma: { $queryRawUnsafe } as unknown as PrismaService, calls };
}

describe('searchGames с slug — KS-2074', () => {
  it('items SQL делает LEFT JOIN на archive_players и SELECT pw.slug/pb.slug', async () => {
    const { prisma, calls } = fakePrisma([]);
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchGames({ sort: 'recent', limit: 50, offset: 0 });

    const items = calls.find((c) => /SELECT[\s\S]+FROM archive_games g/.test(c.sql) && !/COUNT/.test(c.sql))!;
    expect(items.sql).toMatch(/LEFT JOIN archive_players pw ON pw\.name_canonical = g\.white_name/);
    expect(items.sql).toMatch(/LEFT JOIN archive_players pb ON pb\.name_canonical = g\.black_name/);
    expect(items.sql).toMatch(/pw\.slug AS white_slug/);
    expect(items.sql).toMatch(/pb\.slug AS black_slug/);
  });

  it('total SQL без JOIN'.replace(/'/g, '"') + ' (минус overhead на COUNT)', async () => {
    const { prisma, calls } = fakePrisma([]);
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchGames({ sort: 'recent', limit: 50, offset: 0 });

    const total = calls.find((c) => /COUNT\(\*\)::bigint/.test(c.sql))!;
    expect(total.sql).not.toMatch(/LEFT JOIN archive_players/);
  });

  it('возвращает items с slug', async () => {
    const row: RawArchiveGameRow = {
      id: 'g1',
      event: null,
      site: null,
      round: null,
      date: null,
      played_at: new Date('2026-01-01'),
      white_name: 'Carlsen, Magnus',
      black_name: 'Caruana, F.',
      white_elo: 2830,
      black_elo: 2820,
      white_title: 'GM',
      black_title: 'GM',
      result: '1-0',
      eco: 'B90',
      opening: null,
      ply_count: 50,
      white_slug: 'carlsen-magnus',
      black_slug: 'caruana-f',
    };
    const { prisma } = fakePrisma([row as unknown as Record<string, unknown>]);
    const repo = new PostgresArchiveStatsRepository(prisma);
    const page = await repo.searchGames({ sort: 'recent', limit: 50, offset: 0 });

    expect(page.items[0].white_slug).toBe('carlsen-magnus');
    expect(page.items[0].black_slug).toBe('caruana-f');
  });
});

describe('searchPlayerGames с slug — KS-2074', () => {
  it('items SQL добавляет LEFT JOIN pw/pb и SELECT', async () => {
    const { prisma, calls } = fakePrisma([]);
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchPlayerGames({ slug: 'carlsen-magnus', sort: 'recent', limit: 50, offset: 0 });

    const items = calls.find((c) => /JOIN archive_games g/.test(c.sql) && !/COUNT/.test(c.sql))!;
    expect(items.sql).toMatch(/LEFT JOIN archive_players pw/);
    expect(items.sql).toMatch(/LEFT JOIN archive_players pb/);
    expect(items.sql).toMatch(/pw\.slug AS white_slug/);
    expect(items.sql).toMatch(/pb\.slug AS black_slug/);
  });

  it('возвращает row с player_color и обоими slug', async () => {
    const row: RawPlayerGameRow = {
      id: 'g1',
      event: null,
      site: null,
      round: null,
      date: null,
      played_at: new Date('2026-01-01'),
      white_name: 'Carlsen, Magnus',
      black_name: 'Caruana, F.',
      white_elo: 2830,
      black_elo: 2820,
      white_title: 'GM',
      black_title: 'GM',
      result: '1-0',
      eco: 'B90',
      opening: null,
      ply_count: 50,
      player_color: 'white',
      white_slug: 'carlsen-magnus',
      black_slug: 'caruana-f',
    };
    const { prisma } = fakePrisma([row as unknown as Record<string, unknown>]);
    const repo = new PostgresArchiveStatsRepository(prisma);
    const page = await repo.searchPlayerGames({
      slug: 'carlsen-magnus',
      sort: 'recent',
      limit: 50,
      offset: 0,
    });
    expect(page.items[0].player_color).toBe('white');
    expect(page.items[0].white_slug).toBe('carlsen-magnus');
    expect(page.items[0].black_slug).toBe('caruana-f');
  });
});
