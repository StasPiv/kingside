/**
 * KS-2065 — `PostgresArchiveStatsRepository` методы players/events.
 *
 * Через fake-Prisma проверяем:
 *   - SQL построения для searchPlayers/searchEvents (ADR-033 §4.4.4):
 *     pg_trgm `%` + ILIKE prefix-fast path, ORDER BY games_count DESC →
 *     similarity DESC.
 *   - q нормализуется через normalizeArchiveName.
 *   - Ranking: возвращаем результаты в порядке, который даёт fake-Prisma
 *     (мы сами эмулируем правильный ORDER BY) — Carlsen первым по
 *     games_count.
 *   - getPlayerProfile: 404 (null), маппинг полей из MV.
 *   - searchPlayerGames: фильтр color, sort, JOIN.
 */
import type { PrismaService } from '../prisma/prisma.service';
import { PostgresArchiveStatsRepository } from './archive-stats.repository';

interface CapturedCall {
  sql: string;
  params: unknown[];
}

function fakePrisma(handler: (sql: string, params: unknown[]) => unknown[]): {
  prisma: PrismaService;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const $queryRawUnsafe = async <T>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params });
    return handler(sql, params) as unknown as T;
  };
  return { prisma: { $queryRawUnsafe } as unknown as PrismaService, calls };
}

describe('PostgresArchiveStatsRepository.searchPlayers — KS-2065', () => {
  it('строит SQL с pg_trgm % + ILIKE prefix и ORDER BY games_count DESC, similarity DESC', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(2) }];
      // Возвращаем уже отсортированный набор — порядок задаётся fake-prisma
      // как если бы это сделал реальный Postgres ORDER BY.
      return [
        {
          slug: 'carlsen-magnus',
          name_canonical: 'Carlsen, Magnus',
          name_normalized: 'carlsen magnus',
          games_count: 1234,
          peak_elo: 2882,
        },
        {
          slug: 'carlsen-jonas',
          name_canonical: 'Carlsen, Jonas',
          name_normalized: 'carlsen jonas',
          games_count: 7,
          peak_elo: 2350,
        },
      ];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);

    const page = await repo.searchPlayers({ q: 'CARLSEN', limit: 10, offset: 0 });

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    // Самый частый — первый («Carlsen, Magnus» с 1234 партиями).
    expect(page.items[0]).toEqual({
      name: 'Carlsen, Magnus',
      slug: 'carlsen-magnus',
      gamesCount: 1234,
      peakElo: 2882,
    });

    const itemsCall = calls.find((c) => /FROM archive_players/.test(c.sql) && !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(/name_aliases % \$1/);
    expect(itemsCall.sql).toMatch(/name_normalized ILIKE \$1 \|\| '%'/);
    expect(itemsCall.sql).toMatch(/ORDER BY[\s\S]*games_count DESC/);
    expect(itemsCall.sql).toMatch(/similarity\(name_normalized, \$1\) DESC/);
    // q передан нормализованным.
    expect(itemsCall.params[0]).toBe('carlsen');
  });

  it('пустой/мусорный q → пустой результат без SQL-вызовов', async () => {
    const { prisma, calls } = fakePrisma(() => []);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const page = await repo.searchPlayers({ q: ',,,', limit: 10, offset: 0 });
    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('PostgresArchiveStatsRepository.searchEvents — KS-2065', () => {
  it('строит SQL по name_normalized с GIN trgm', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(1) }];
      return [
        {
          slug: 'tata-steel-2024',
          name_canonical: 'Tata Steel 2024',
          name_normalized: 'tata steel 2024',
          games_count: 91,
          first_date: '2024.01.13',
          last_date: '2024.01.28',
        },
      ];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);

    const page = await repo.searchEvents({ q: 'tata', limit: 10, offset: 0 });

    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual({
      name: 'Tata Steel 2024',
      slug: 'tata-steel-2024',
      gamesCount: 91,
      firstDate: '2024.01.13',
      lastDate: '2024.01.28',
    });
    const itemsCall = calls.find((c) => /FROM archive_events/.test(c.sql) && !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(/name_normalized % \$1/);
    expect(itemsCall.params[0]).toBe('tata');
  });
});

describe('PostgresArchiveStatsRepository.getPlayerProfile — KS-2065', () => {
  it('404 (null) когда slug не найден', async () => {
    const { prisma } = fakePrisma(() => []);
    const repo = new PostgresArchiveStatsRepository(prisma);
    const res = await repo.getPlayerProfile('unknown');
    expect(res).toBeNull();
  });

  it('маппит JOIN archive_players × archive_player_stats', async () => {
    const FIRST = new Date('2010-01-01T00:00:00Z');
    const LAST = new Date('2026-04-01T00:00:00Z');
    const { prisma, calls } = fakePrisma(() => [
      {
        slug: 'carlsen-magnus',
        name_canonical: 'Carlsen, Magnus',
        peak_elo: 2882,
        first_seen_at: null,
        last_seen_at: null,
        games_count: 1234,
        games_white: 700,
        games_black: 534,
        wins: 600,
        draws: 500,
        losses: 134,
        s_peak_elo: 2882,
        s_first_seen_at: FIRST,
        s_last_seen_at: LAST,
      },
    ]);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const profile = await repo.getPlayerProfile('carlsen-magnus');

    expect(profile).toEqual({
      name: 'Carlsen, Magnus',
      slug: 'carlsen-magnus',
      gamesCount: 1234,
      peakElo: 2882,
      byColor: { white: 700, black: 534 },
      byResult: { wins: 600, draws: 500, losses: 134 },
      firstSeenAt: FIRST.toISOString(),
      lastSeenAt: LAST.toISOString(),
    });
    // Параметризован slug.
    expect(calls[0].params).toEqual(['carlsen-magnus']);
    expect(calls[0].sql).toMatch(/LEFT JOIN archive_player_stats/);
  });

  it('LEFT JOIN: если MV ещё не пересчитан — нули агрегатов и ISO-формат дат из archive_players', async () => {
    const FIRST = new Date('2024-01-01T00:00:00Z');
    const { prisma } = fakePrisma(() => [
      {
        slug: 'new-player',
        name_canonical: 'New Player',
        peak_elo: 2400,
        first_seen_at: FIRST,
        last_seen_at: FIRST,
        games_count: 0,
        games_white: 0,
        games_black: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        s_peak_elo: null,
        s_first_seen_at: null,
        s_last_seen_at: null,
      },
    ]);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const profile = await repo.getPlayerProfile('new-player');

    expect(profile?.gamesCount).toBe(0);
    expect(profile?.peakElo).toBe(2400); // fallback из archive_players.peak_elo
    expect(profile?.firstSeenAt).toBe(FIRST.toISOString());
  });
});

describe('PostgresArchiveStatsRepository.searchPlayerGames — KS-2065', () => {
  function defaults() {
    return {
      slug: 'carlsen-magnus',
      sort: 'recent' as const,
      limit: 50,
      offset: 0,
    };
  }

  it('фильтр color=white вешает g.white_name = p.name_canonical', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(0) }];
      return [];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchPlayerGames({ ...defaults(), color: 'white' });

    const itemsCall = calls.find((c) => !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(/g\.white_name = p\.name_canonical/);
    expect(itemsCall.sql).not.toMatch(/g\.black_name = p\.name_canonical(\s+(?!OR))/);
  });

  it('color=any (default) — оба цвета через OR', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(0) }];
      return [];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchPlayerGames(defaults());

    const itemsCall = calls.find((c) => !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(
      /\(g\.white_name = p\.name_canonical OR g\.black_name = p\.name_canonical\)/,
    );
  });

  it('player_color считается через CASE и попадает в выдачу', async () => {
    const { prisma } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(1) }];
      return [
        {
          id: 'g1',
          event: 'Test',
          site: null,
          round: null,
          date: null,
          played_at: new Date('2024-01-01'),
          white_name: 'Carlsen, Magnus',
          black_name: 'Caruana, F.',
          white_elo: 2830,
          black_elo: 2820,
          white_title: 'GM',
          black_title: 'GM',
          result: '1-0',
          eco: 'B90',
          opening: 'Sicilian',
          ply_count: 50,
          player_color: 'white',
        },
      ];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);
    const page = await repo.searchPlayerGames(defaults());
    expect(page.total).toBe(1);
    expect(page.items[0].player_color).toBe('white');
  });

  it('sort=topElo → ORDER BY GREATEST(...)', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(0) }];
      return [];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);
    await repo.searchPlayerGames({ ...defaults(), sort: 'topElo' });
    const itemsCall = calls.find((c) => !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(
      /ORDER BY GREATEST\(g\.white_elo, g\.black_elo\) DESC NULLS LAST, g\.id DESC/,
    );
  });

  it('фильтры since/until/eco/event/minPly/maxPly попадают в WHERE', async () => {
    const { prisma, calls } = fakePrisma((sql) => {
      if (/COUNT\(\*\)::bigint/.test(sql)) return [{ total: BigInt(0) }];
      return [];
    });
    const repo = new PostgresArchiveStatsRepository(prisma);
    const since = new Date('2020-01-01');
    const until = new Date('2024-12-31');
    await repo.searchPlayerGames({
      ...defaults(),
      since,
      until,
      eco: 'B90',
      event: 'Tata',
      minPly: 20,
      maxPly: 100,
      minElo: 2700,
    });
    const itemsCall = calls.find((c) => !/COUNT/.test(c.sql))!;
    expect(itemsCall.sql).toMatch(/g\.played_at >= /);
    expect(itemsCall.sql).toMatch(/g\.played_at <= /);
    expect(itemsCall.sql).toMatch(/g\.eco = /);
    expect(itemsCall.sql).toMatch(/g\.event ILIKE /);
    expect(itemsCall.sql).toMatch(/g\.ply_count >= /);
    expect(itemsCall.sql).toMatch(/g\.ply_count <= /);
    expect(itemsCall.sql).toMatch(/g\.white_elo >= /);
    expect(itemsCall.sql).toMatch(/g\.black_elo >= /);
    expect(itemsCall.params).toContain(since);
    expect(itemsCall.params).toContain(until);
    expect(itemsCall.params).toContain('B90');
    expect(itemsCall.params).toContain('%Tata%');
    expect(itemsCall.params).toContain(20);
    expect(itemsCall.params).toContain(100);
    expect(itemsCall.params).toContain(2700);
  });
});
