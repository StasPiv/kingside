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

    it('skipTotal (KS-2090 / KS-2140) → COUNT(*) не выполняется, total = null', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      const page = await repo.searchGames({ ...defaults(), skipTotal: true });

      // Только items-запрос, COUNT не должен быть.
      const totalCalls = calls.filter((c) => /COUNT\(\*\)::bigint/.test(c.sql));
      expect(totalCalls).toHaveLength(0);
      expect(calls.filter((c) => /SELECT[\s\S]+FROM archive_games g/.test(c.sql)
        && !/COUNT/.test(c.sql))).toHaveLength(1);
      // KS-2140: total = null (явный контракт «не считали»), а не
      // items.length. Frontend (KS-2141) использует hasNext для
      // пагинации.
      expect(page.total).toBeNull();
      expect(typeof page.hasNext).toBe('boolean');
    });

    it('skipTotal не задан → COUNT(*) выполняется как раньше (регрессия)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames(defaults());

      expect(calls.filter((c) => /COUNT\(\*\)::bigint/.test(c.sql))).toHaveLength(1);
    });

    it('LIMIT+1 (KS-2140) и OFFSET идут параметрами после фильтров', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), eco: 'B90', limit: 25, offset: 100 });

      const items = findItemsCall(calls);
      // KS-2140: items SQL запрашивает limit+1 (n+1 для hasNext).
      expect(items.params[items.params.length - 2]).toBe(26);
      expect(items.params[items.params.length - 1]).toBe(100);
      // total-запрос не получает limit/offset.
      const total = findTotalCall(calls);
      expect(total.params).not.toContain(25);
      expect(total.params).not.toContain(26);
      expect(total.params).not.toContain(100);
    });

    it('без фильтров — нет WHERE', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames(defaults());

      const items = findItemsCall(calls);
      expect(items.sql).not.toMatch(/WHERE\s/);
    });

    // ─── KS-2118 — timeControlCategory ────────────────────────────────

    it('KS-2118: одна категория → time_control_category = $n (равенство, индекс)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({
        ...defaults(),
        timeControlCategory: ['classical'],
      });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/g\.time_control_category = \$\d+/);
      expect(items.sql).not.toMatch(/= ANY\(/);
      expect(items.params).toContain('classical');

      const total = findTotalCall(calls);
      expect(total.sql).toMatch(/g\.time_control_category = \$\d+/);
      expect(total.params).toContain('classical');
    });

    it('KS-2118: массив категорий → time_control_category = ANY($n)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({
        ...defaults(),
        timeControlCategory: ['blitz', 'rapid'],
      });

      const items = findItemsCall(calls);
      expect(items.sql).toMatch(/g\.time_control_category = ANY\(\$\d+\)/);
      // Массив проброшен как один параметр, не разворачивается.
      const arrayParam = items.params.find((p) => Array.isArray(p));
      expect(arrayParam).toEqual(['blitz', 'rapid']);
    });

    it('KS-2118: SELECT включает time_control и time_control_category', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames(defaults());

      const items = findItemsCall(calls);
      expect(items.sql).toContain('g.time_control');
      expect(items.sql).toContain('g.time_control_category');
    });

    it('KS-2118: пустой массив timeControlCategory → нет фильтра в WHERE', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({ ...defaults(), timeControlCategory: [] });

      const items = findItemsCall(calls);
      // SELECT-лист всегда содержит `g.time_control_category` (мы отдаём поле
      // на фронт). Проверяем именно отсутствие фильтра — нет сравнения и нет
      // WHERE с этой колонкой.
      expect(items.sql).not.toMatch(/g\.time_control_category\s*=/);
      expect(items.sql).not.toMatch(/g\.time_control_category\s+ANY/);
    });

    it('KS-2118: AND с другими фильтрами (event + timeControlCategory)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      await repo.searchGames({
        ...defaults(),
        event: 'Tata Steel',
        timeControlCategory: ['classical'],
      });

      const items = findItemsCall(calls);
      // Оба условия в WHERE, через AND.
      expect(items.sql).toMatch(/event ILIKE \$\d+/);
      expect(items.sql).toMatch(/g\.time_control_category = \$\d+/);
      expect(items.sql).toMatch(/AND/);
    });
  });
});
