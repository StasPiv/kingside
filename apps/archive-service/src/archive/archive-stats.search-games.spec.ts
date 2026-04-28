/**
 * KS-2063 — `PostgresArchiveStatsRepository.searchGames` (metadata-list).
 *
 * Здесь проверяется построение SQL: WHERE-ветки на новые фильтры
 * (until/event/minPly/maxPly), ORDER BY для трёх сортировок, корректная
 * параметризация и отсутствие SQL-инъекций (значения попадают параметрами,
 * не в текст SQL).
 */
import type { PrismaService } from '../prisma/prisma.service';
import {
  PostgresArchiveStatsRepository,
  RawArchiveGameRow,
  SearchGamesOpts,
} from './archive-stats.repository';

interface CapturedCall {
  sql: string;
  params: unknown[];
}

/** Собирает все SQL-вызовы; возвращает фиктивные строки/total. */
function fakePrisma(): { prisma: PrismaService; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const $queryRawUnsafe = async <T>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)::bigint/.test(sql)) {
      return [{ total: BigInt(42) }] as unknown as T;
    }
    // items-запрос — возвращаем одну фиктивную строку.
    const row: RawArchiveGameRow = {
      id: '00000000-0000-0000-0000-000000000001',
      event: 'Test Cup',
      site: null,
      round: null,
      date: '2026.04.01',
      played_at: new Date('2026-04-01T00:00:00Z'),
      white_name: 'Carlsen, Magnus',
      black_name: 'Caruana, Fabiano',
      white_elo: 2830,
      black_elo: 2820,
      white_title: 'GM',
      black_title: 'GM',
      result: '1-0',
      eco: 'B90',
      opening: 'Sicilian',
      ply_count: 65,
    };
    return [row] as unknown as T;
  };
  return {
    prisma: { $queryRawUnsafe } as unknown as PrismaService,
    calls,
  };
}

function defaults(): SearchGamesOpts {
  return { sort: 'recent', limit: 50, offset: 0 };
}

function findItemsCall(calls: CapturedCall[]): CapturedCall {
  const c = calls.find((x) => /SELECT[\s\S]+FROM archive_games/.test(x.sql) && !/COUNT\(\*\)/.test(x.sql));
  if (!c) throw new Error('items SQL not captured');
  return c;
}

function findTotalCall(calls: CapturedCall[]): CapturedCall {
  const c = calls.find((x) => /COUNT\(\*\)::bigint/.test(x.sql));
  if (!c) throw new Error('total SQL not captured');
  return c;
}

describe('PostgresArchiveStatsRepository.searchGames — KS-2063', () => {
  it('возвращает total из COUNT(*) и items из второго запроса', async () => {
    const { prisma, calls } = fakePrisma();
    const repo = new PostgresArchiveStatsRepository(prisma);

    const page = await repo.searchGames(defaults());

    expect(page.total).toBe(42);
    expect(page.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  describe('сортировки', () => {
    it.each([
      ['recent', 'g.played_at DESC NULLS LAST, g.id DESC'],
      ['topElo', 'GREATEST(g.white_elo, g.black_elo) DESC NULLS LAST, g.id DESC'],
      ['oldest', 'g.played_at ASC NULLS LAST, g.id ASC'],
    ] as const)('%s → ORDER BY %s', async (sort, expected) => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);

      await repo.searchGames({ ...defaults(), sort });

      const itemsSql = findItemsCall(calls).sql;
      expect(itemsSql).toContain(`ORDER BY ${expected}`);
    });
  });

  describe('фильтры', () => {
    it('until → played_at <= ${until}', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      const until = new Date('2026-12-31T23:59:59Z');
      await repo.searchGames({ ...defaults(), until });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/played_at <= \$\d+/);
      expect(items.params).toContain(until);

      // Тот же фильтр должен попасть и в COUNT-запрос.
      const total = findTotalCall(calls);
      expect(total.sql).toMatch(/played_at <= \$\d+/);
      expect(total.params).toContain(until);
    });

    it('event → ILIKE substring', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), event: 'Tata Steel' });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/event ILIKE \$\d+/);
      expect(items.params).toContain('%Tata Steel%');
    });

    it('minPly + maxPly → BETWEEN-эквивалент', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), minPly: 20, maxPly: 80 });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/ply_count >= \$\d+/);
      expect(items.sql).toMatch(/ply_count <= \$\d+/);
      expect(items.params).toContain(20);
      expect(items.params).toContain(80);
    });

    it('minPly один — только нижняя граница', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), minPly: 30 });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/ply_count >= \$\d+/);
      expect(items.sql).not.toMatch(/ply_count <= /);
    });

    it('player (строка) → OR на оба имени с одинаковым параметром', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), player: 'Carlsen' });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/g\.white_name ILIKE \$\d+ OR g\.black_name ILIKE \$\d+/);
      expect(items.params).toContain('%Carlsen%');
    });

    it('player (массив, KS-2081) → AND из двух OR-блоков', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), player: ['Carlsen,M', 'Caruana,F'] });

      const items = findItemsCall(calls);
      // Два независимых OR-блока с разными плейсхолдерами.
      const orBlocks = items.sql.match(
        /\(g\.white_name ILIKE \$\d+ OR g\.black_name ILIKE \$\d+\)/g,
      );
      expect(orBlocks).not.toBeNull();
      expect(orBlocks!.length).toBe(2);
      // Параметры обоих игроков обёрнуты в %...%.
      expect(items.params).toContain('%Carlsen,M%');
      expect(items.params).toContain('%Caruana,F%');

      // Тот же фильтр в COUNT-запросе.
      const total = findTotalCall(calls);
      expect(total.params).toContain('%Carlsen,M%');
      expect(total.params).toContain('%Caruana,F%');
    });

    it('player (массив с пустыми и пробельными элементами) → пропуск пустых', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), player: ['Carlsen', '', '  '] });

      const items = findItemsCall(calls);
      const orBlocks = items.sql.match(
        /\(g\.white_name ILIKE \$\d+ OR g\.black_name ILIKE \$\d+\)/g,
      );
      // Только один валидный элемент — Carlsen.
      expect(orBlocks!.length).toBe(1);
      expect(items.params).toContain('%Carlsen%');
    });

    it('player (пустой массив) → нет WHERE-веток на player', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), player: [] });

      const items = findItemsCall(calls);
      expect(items.sql).not.toMatch(/g\.white_name ILIKE/);
    });

    it('LIMIT и OFFSET идут параметрами после фильтров', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), eco: 'B90', limit: 25, offset: 100 });

      const items = findItemsCall(calls);
      // LIMIT/OFFSET — последние два параметра.
      expect(items.params[items.params.length - 2]).toBe(25);
      expect(items.params[items.params.length - 1]).toBe(100);
      // total-запрос не получает limit/offset.
      const total = findTotalCall(calls);
      expect(total.params).not.toContain(25);
      expect(total.params).not.toContain(100);
    });

    it('без фильтров — нет WHERE', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames(defaults());

      const items = findItemsCall(calls);
      expect(items.sql).not.toMatch(/WHERE\s/);
    });
  });
});
