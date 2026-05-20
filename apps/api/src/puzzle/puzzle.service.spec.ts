import { NotFoundException } from '@nestjs/common';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

describe('PuzzleService', () => {
  let service: PuzzleService;
  let prisma: any;
  let i18n: any;
  let ratingService: any;
  let mistakes: any;

  beforeEach(() => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      puzzleAttempt: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn(),
      },
      puzzleRushScore: {
        findFirst: jest.fn(),
      },
      puzzleRatingSnapshot: {
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    };

    ratingService = {
      applyRatingChange: jest.fn(),
    };

    const redis = { get: jest.fn(), set: jest.fn() } as any;
    mistakes = {
      recordPuzzleMistake: jest.fn().mockResolvedValue(undefined),
      recordGameMistake: jest.fn().mockResolvedValue(undefined),
    };
    service = new PuzzleService(prisma, i18n, ratingService, redis, mistakes);
  });

  describe('findPuzzles', () => {
    it('should return puzzles filtered by rating range', async () => {
      const mockPuzzles = [
        { id: '1', fen: 'fen1', moves: 'e2e4 e7e5', rating: 1300, themes: 'fork pin' },
      ];
      prisma.puzzle.findMany.mockResolvedValue(mockPuzzles);

      const result = await service.findPuzzles({ ratingMin: 1200, ratingMax: 1400 });

      expect(result).toHaveLength(1);
      expect(result[0].rating).toBe(1300);
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rating: { gte: 1200, lte: 1400 } },
        }),
      );
    });

    it('should filter by themes using contains', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork', 'pin'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { themes: { contains: 'fork' } },
              { themes: { contains: 'pin' } },
            ],
          },
        }),
      );
    });

    it('should use default limit of 10', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({});

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('should respect custom limit', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ limit: 5 });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should combine theme and rating filters', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['mate'], ratingMin: 1000, ratingMax: 1500 });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            rating: { gte: 1000, lte: 1500 },
            AND: [{ themes: { contains: 'mate' } }],
          },
        }),
      );
    });

    // ── KS-2472 / ADR-044 §5.5: solutionMode фильтр ───────────────

    it('KS-2472: solutionMode=play-vs-engine добавляет where.solutionMode', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ solutionMode: 'play-vs-engine' });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { solutionMode: 'play-vs-engine' },
        }),
      );
    });

    it('KS-2472: solutionMode=forced-line добавляет where.solutionMode', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ solutionMode: 'forced-line' });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { solutionMode: 'forced-line' },
        }),
      );
    });

    it('KS-2472: без solutionMode → where.solutionMode не выставляется', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ ratingMin: 1000 });

      const callArg = prisma.puzzle.findMany.mock.calls[0][0];
      expect(callArg.where.solutionMode).toBeUndefined();
    });

    it('KS-2472: solutionMode комбинируется с другими фильтрами', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({
        themes: ['mate'],
        ratingMin: 1000,
        ratingMax: 1500,
        solutionMode: 'play-vs-engine',
      });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            rating: { gte: 1000, lte: 1500 },
            AND: [{ themes: { contains: 'mate' } }],
            solutionMode: 'play-vs-engine',
          },
        }),
      );
    });

    // ── KS-1761 (L-06): расширение для LessonsModule ──────────────

    it('KS-1761: ANDs all themes when a multi-theme filter is provided', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork', 'pin', 'mateIn2'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { themes: { contains: 'fork' } },
              { themes: { contains: 'pin' } },
              { themes: { contains: 'mateIn2' } },
            ],
          },
        }),
      );
    });

    it('KS-1761: filters by source when provided', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork'], source: 'lichess' });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: 'lichess',
            AND: [{ themes: { contains: 'fork' } }],
          }),
        }),
      );
    });

    it('KS-1761: excludes ids when excludeIds provided', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ excludeIds: ['x', 'y'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['x', 'y'] },
          }),
        }),
      );
    });

    // ── KS-1776: orderBy variants ─────────────────────────────────

    it("KS-1776: default orderBy is { rating: 'asc' } (backward-compat)", async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork'] });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { rating: 'asc' } }),
      );
    });

    it("KS-1776: orderBy='popularity' uses prisma findMany with { popularity: 'desc' }", async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await service.findPuzzles({ themes: ['fork'], orderBy: 'popularity' });

      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { popularity: 'desc' } }),
      );
    });

    it("KS-1776: orderBy='random' uses raw SQL with ORDER BY random()", async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 'p1', fen: 'f', moves: 'e2e4', rating: 1200, themes: 'fork', source: 'lichess', game_url: null, opening_tags: null },
      ]);

      const res = await service.findPuzzles({
        themes: ['fork'],
        ratingMin: 1000,
        ratingMax: 1500,
        source: 'lichess',
        limit: 5,
        orderBy: 'random',
      });

      expect(prisma.puzzle.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
      const [sql, ...sqlParams] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('ORDER BY random()');
      expect(sql).toContain('LIMIT 5');
      // параметры (rating min, rating max, source, theme)
      expect(sqlParams).toEqual(expect.arrayContaining([1000, 1500, 'lichess', '%fork%']));
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('p1');
    });

    it("KS-1776: orderBy='random' propagates excludeIds as NOT IN", async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findPuzzles({
        themes: ['pin'],
        excludeIds: ['a', 'b', 'c'],
        orderBy: 'random',
      });

      const [sql, ...sqlParams] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toMatch(/NOT IN \(\$\d+, \$\d+, \$\d+\)/);
      expect(sqlParams).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    });
  });

  describe('getNextPuzzleByTheme', () => {
    it('should filter by theme and user rating range', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1200 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p1', fen: 'fen', moves: 'e2e4', rating: 1200, themes: 'fork' },
      ]);

      const result = await service.getNextPuzzleByTheme('user-1', 'fork');

      expect(result).toBeDefined();
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            themes: { contains: 'fork' },
            rating: { gte: 1000, lte: 1400 },
          }),
        }),
      );
    });

    it('should throw NotFoundException when no puzzles for theme', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzle.findMany.mockResolvedValue([]);

      await expect(service.getNextPuzzleByTheme('user-1', 'zugzwang')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should exclude all attempted puzzles (KS-299)', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.puzzleAttempt.findMany.mockResolvedValue([
        { puzzleId: 'p1' },
        { puzzleId: 'p2' },
      ]);
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p3', fen: 'fen', moves: 'e2e4', rating: 1500, themes: 'fork' },
      ]);

      await service.getNextPuzzleByTheme('user-1', 'fork');

      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
        }),
      );
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['p1', 'p2'] },
          }),
        }),
      );
    });
  });

  describe('getNextPuzzle (KS-2733)', () => {
    it('solutionMode=play-vs-engine → SQL содержит фильтр solution_mode', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      const fakePve = {
        id: 'pve-1',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'playVsEngine',
        source: 'generated',
        solution_mode: 'play-vs-engine',
        source_metadata: '{}',
        game_url: null,
        opening_tags: null,
      };
      prisma.$queryRawUnsafe.mockResolvedValueOnce([fakePve]);

      await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'play-vs-engine',
      });

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      const params = prisma.$queryRawUnsafe.mock.calls[0].slice(1);
      expect(sql).toContain('p.solution_mode =');
      // Параметр solutionMode должен быть в списке.
      expect(params).toContain('play-vs-engine');
    });

    it('solutionMode=forced-line → фильтр forced-line', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'fl-1',
          fen: 'fen',
          moves: 'e2e4 e7e5',
          rating: 1500,
          themes: 'fork',
          source: 'lichess',
          solution_mode: 'forced-line',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'forced-line',
      });

      const params = prisma.$queryRawUnsafe.mock.calls[0].slice(1);
      expect(params).toContain('forced-line');
    });

    it('без solutionMode → SQL не имеет фильтра по solution_mode', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'p1',
          fen: 'fen',
          moves: 'e2e4',
          rating: 1500,
          themes: 'fork',
          source: 'lichess',
          solution_mode: 'forced-line',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle('user-1', undefined, {});

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).not.toContain('p.solution_mode');
    });

    it('KS-2733: fallback при пустом основном результате не падает с SQL placeholder error', async () => {
      // Раньше fallback делал params.slice(2) и оставлял условия со
      // ссылками на $3/$4 — SQL получал «несуществующие placeholder'ы»
      // и возвращал 500. После KS-2733/2735-фикса каждый шаг каскада
      // строится с индексами параметров начиная с $1.
      //
      // KS-3032: для PVE по default включается строгий exclude
      // (`all-attempted`) без каскада. Чтобы здесь проверить именно
      // переиндексацию параметров на 4-м шаге каскада — явно передаём
      // `includeAttempted=true` (возвращаем legacy-каскад).
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      // Все шаги strict (recent-7d, recent-1d, solved-only) пусты,
      // на 4-м шаге (relaxed + solved-only) возвращаем пазл.
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'pve-fb',
            fen: 'fen',
            moves: '',
            rating: 800,
            themes: 'playVsEngine',
            source: 'generated',
            solution_mode: 'play-vs-engine',
            source_metadata: '{}',
            game_url: null,
            opening_tags: null,
          },
        ]);

      const r = await service.getNextPuzzle('user-1', 'exclude-id', {
        solutionMode: 'play-vs-engine',
        includeAttempted: true,
      });

      expect(r.id).toBe('pve-fb');
      // Проверим что для каждого вызова SQL placeholder'ы соответствуют
      // числу параметров — нет ссылок на несуществующие $N.
      for (const call of prisma.$queryRawUnsafe.mock.calls) {
        const sql = call[0] as string;
        const ps = call.slice(1);
        const placeholders = sql.match(/\$\d+/g) ?? [];
        const maxPh = placeholders.length
          ? Math.max(...placeholders.map((p) => parseInt(p.slice(1))))
          : 0;
        expect(maxPh).toBe(ps.length);
      }
    });

    // ── KS-2735: anti-repeat 7d-окно + каскад fallback'ов ─────────

    it('KS-2735: primary запрос исключает попытки за 7 дней', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'p1',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: '',
          source: 'lichess',
          solution_mode: 'forced-line',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle('user-1');

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      // Primary должен быть с recent-7d window.
      expect(sql).toContain("INTERVAL '7 days'");
      expect(sql).toContain('NOT EXISTS');
      expect(sql).not.toContain('solved = true'); // не old-style на primary
    });

    it('KS-2735: каскад при последовательных пустых ответах — 7d → 1d → solved → relaxed → none', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      // Все 4 уровня пустые, 5-й (none + relaxed) возвращает.
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'p-last',
            fen: 'fen',
            moves: '',
            rating: 800,
            themes: '',
            source: 'lichess',
            solution_mode: 'forced-line',
            source_metadata: null,
            game_url: null,
            opening_tags: null,
          },
        ]);

      const r = await service.getNextPuzzle('user-1');

      expect(r.id).toBe('p-last');
      // 5 вызовов соответствуют 5 уровням каскада.
      expect(prisma.$queryRawUnsafe.mock.calls.length).toBe(5);
      const sqls = prisma.$queryRawUnsafe.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(sqls[0]).toContain("INTERVAL '7 days'");
      expect(sqls[1]).toContain("INTERVAL '1 day'");
      expect(sqls[2]).toContain('solved = true');
      expect(sqls[3]).toContain('solved = true'); // relaxed + solved-only
      // 5-й — none, без NOT EXISTS на user_attempts (только excludeId/themes/etc).
      // Проверим что нет NOT EXISTS user_id.
      expect(sqls[4]).not.toContain('user_id');
    });

    // ── KS-3032: строгий all-attempted exclude для PVE ───────────

    it('KS-3032: PVE без includeAttempted → строгий all-attempted exclude (NOT EXISTS без INTERVAL и без solved=true)', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'pve-fresh',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: 'playVsEngine',
          source: 'generated',
          solution_mode: 'play-vs-engine',
          source_metadata: '{}',
          game_url: null,
          opening_tags: null,
        },
      ]);

      const r = await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'play-vs-engine',
      });

      expect(r.id).toBe('pve-fresh');
      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('NOT EXISTS');
      // KS-3032: НЕТ временного окна и НЕТ фильтра по solved.
      expect(sql).not.toContain('INTERVAL');
      expect(sql).not.toContain('solved = true');
    });

    it('KS-3032: PVE — strict пуст, relaxed пуст → 404 (без fallback на none)', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      // Обе попытки (strict + relaxed) пустые. Фронт должен показать
      // «Все пройдены», без повтора старых задач.
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        service.getNextPuzzle('user-1', undefined, {
          solutionMode: 'play-vs-engine',
        }),
      ).rejects.toThrow('messages.puzzle.noPuzzlesAvailable');

      // ровно 2 SQL-запроса (strict + relaxed), без каскада на 5
      // уровней.
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    });

    it('KS-3032: PVE — strict пуст, relaxed возвращает → выдаёт relaxed-вариант', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'pve-relaxed',
            fen: 'fen',
            moves: '',
            rating: 2000,
            themes: 'playVsEngine',
            source: 'generated',
            solution_mode: 'play-vs-engine',
            source_metadata: '{}',
            game_url: null,
            opening_tags: null,
          },
        ]);

      const r = await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'play-vs-engine',
      });

      expect(r.id).toBe('pve-relaxed');
      // 2-й запрос — relaxed (без rating window и popularity).
      const sql2 = prisma.$queryRawUnsafe.mock.calls[1][0] as string;
      expect(sql2).not.toContain('p.rating >=');
      expect(sql2).not.toContain('popularity >= 50');
    });

    it('KS-3032: PVE + includeAttempted=true → каскад (recent-7d → ...), не all-attempted', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'pve-cascade',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: 'playVsEngine',
          source: 'generated',
          solution_mode: 'play-vs-engine',
          source_metadata: '{}',
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'play-vs-engine',
        includeAttempted: true,
      });

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain("INTERVAL '7 days'"); // legacy каскад
    });

    it('KS-3032: forced-line — без изменений (каскад как раньше)', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'fl-1',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: 'fork',
          source: 'lichess',
          solution_mode: 'forced-line',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle('user-1', undefined, {
        solutionMode: 'forced-line',
      });

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      // forced-line идёт по каскаду recent-7d.
      expect(sql).toContain("INTERVAL '7 days'");
    });

    it('KS-3032: anonymous (userId=null) + PVE → нет user-exclude (как раньше)', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'pve-anon',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: 'playVsEngine',
          source: 'generated',
          solution_mode: 'play-vs-engine',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle(null, undefined, {
        solutionMode: 'play-vs-engine',
      });

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      // Для anon — каскадный путь, без user-exclude.
      expect(sql).not.toContain('user_id');
    });

    it('KS-2735: anonymous (userId=null) → нет user-exclude вообще', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          id: 'p-anon',
          fen: 'fen',
          moves: '',
          rating: 1500,
          themes: '',
          source: 'lichess',
          solution_mode: 'forced-line',
          source_metadata: null,
          game_url: null,
          opening_tags: null,
        },
      ]);

      await service.getNextPuzzle(null);

      const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).not.toContain('user_id');
      expect(sql).not.toContain("INTERVAL");
    });
  });

  describe('submitAttempt', () => {
    const mockPuzzle = { id: 'p1', fen: 'fen', moves: 'e2e4 e7e5', rating: 1500, themes: 'fork' };

    it('should return nextPuzzle in response to avoid race condition', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1200,
        userRatingAfter: 1210,
        puzzleRatingAfter: 1495,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      // Mock getNextPuzzle dependencies (raw query for next puzzle)
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1210 });
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 'p2', fen: 'fen2', moves: 'e2e4', rating: 1300, themes: 'pin', source: 'lichess', game_url: null, opening_tags: null },
      ]);

      const result = await service.submitAttempt('user-1', 'p1', true, 5000);

      expect(result.nextPuzzle).toBeDefined();
      expect(result.nextPuzzle?.id).toBe('p2');
      expect(result.solved).toBe(true);
    });

    it('should return nextPuzzle=null when no puzzles available', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1200,
        userRatingAfter: 1190,
        puzzleRatingAfter: 1505,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1190 });
      // Both primary and fallback raw queries return empty → getNextPuzzle throws,
      // submitAttempt catches and sets nextPuzzle = null.
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.submitAttempt('user-1', 'p1', false, 3000);

      expect(result.nextPuzzle).toBeNull();
      expect(result.solved).toBe(false);
    });

    // ── L-31 (KS-1802): hook in mistakes journal ──────────────────

    it('KS-1802: вызывает recordPuzzleMistake при неудачной попытке', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1200,
        userRatingAfter: 1190,
        puzzleRatingAfter: 1505,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1190 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.submitAttempt('user-1', 'p1', false, 3000);

      expect(mistakes.recordPuzzleMistake).toHaveBeenCalledWith('user-1', 'p1');
    });

    it('KS-1802: НЕ вызывает recordPuzzleMistake при успешной попытке', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1200,
        userRatingAfter: 1210,
        puzzleRatingAfter: 1495,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1210 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.submitAttempt('user-1', 'p1', true, 5000);

      expect(mistakes.recordPuzzleMistake).not.toHaveBeenCalled();
    });
  });

  describe('getPuzzle', () => {
    it('should return formatted puzzle when found', async () => {
      const puzzle = { id: 'abc123', fen: 'fen1', moves: 'e2e4 e7e5', rating: 1500, themes: 'fork pin' };
      prisma.puzzle.findUnique.mockResolvedValue(puzzle);

      const result = await service.getPuzzle('abc123');
      expect(result.id).toBe('abc123');
      expect(result.moves).toEqual(['e2e4', 'e7e5']);
      expect(result.themes).toEqual(['fork', 'pin']);
    });

    it('should throw NotFoundException when puzzle not found', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      await expect(service.getPuzzle('nonexistent')).rejects.toThrow(NotFoundException);
    });

    // ── KS-2465 / ADR-044 §5.5. solutionMode + playVsEngine ─────────

    it("KS-2465: forced-line puzzle получает solutionMode='forced-line' без блока playVsEngine", async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pf1',
        fen: 'fen-classic',
        moves: 'e2e4 e7e5 g1f3',
        rating: 1500,
        themes: 'fork',
        source: 'lichess',
        solutionMode: 'forced-line',
        sourceMetadata: null,
      });

      const result = await service.getPuzzle('pf1');

      expect(result.solutionMode).toBe('forced-line');
      expect((result as { playVsEngine?: unknown }).playVsEngine).toBeUndefined();
    });

    it('KS-2465: play-vs-engine puzzle парсит sourceMetadata и отдаёт playVsEngine блок', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve1',
        fen: 'fen-after-blunder',
        moves: '',
        rating: 1700,
        themes: 'sacrifice playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve1');

      expect(result.solutionMode).toBe('play-vs-engine');
      expect((result as { playVsEngine?: typeof meta }).playVsEngine).toEqual(meta);
    });

    it('KS-2665: sourceMetadata только с blunderMove + wdlAfterBlunder → пороги из PUZZLE_GEN_DEFAULTS', async () => {
      // ADR-050 §3 #5: фронт-генератор (KS-2584) НЕ передаёт
      // winThreshold/failThreshold/halfMovesN — это серверные дефолты.
      // До KS-2665 resolver требовал их в meta и при отсутствии
      // откидывал весь блок → фронт на /precision показывал
      // «Соперник зевнул ходом ?». После фикса — пороги берутся из
      // shared PUZZLE_GEN_DEFAULTS, блок собирается корректно.
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        // halfMovesN/winThreshold/failThreshold намеренно отсутствуют.
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-frontend-gen',
        fen: 'fen-after-blunder',
        moves: '',
        rating: 1700,
        themes: 'sacrifice playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-frontend-gen');

      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as { playVsEngine?: Record<string, unknown> }).playVsEngine;
      expect(pve).toBeDefined();
      expect(pve!.blunderMove).toBe('e2e4');
      expect(pve!.wdlAfterBlunder).toBe(0.78);
      // Сервер подставил дефолты.
      expect(pve!.halfMovesN).toBe(6);
      expect(pve!.winThreshold).toBe(0.5);
      expect(pve!.failThreshold).toBe(0.0);
    });

    it('KS-2665: sourceMetadata без blunderMove → fallback forced-line', async () => {
      // Если blunderMove отсутствует — нечего показать UI на
      // /precision, fallback на forced-line.
      const meta = {
        // blunderMove отсутствует
        wdlAfterBlunder: 0.78,
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-no-blunder',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: '',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-no-blunder');
      expect(result.solutionMode).toBe('forced-line');
      expect((result as { playVsEngine?: unknown }).playVsEngine).toBeUndefined();
    });

    it('KS-2465: play-vs-engine с битым JSON → fallback forced-line + warn', async () => {
      const warnSpy = jest
        .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-bad',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: '',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: '{not json',
      });

      const result = await service.getPuzzle('pve-bad');

      expect(result.solutionMode).toBe('forced-line');
      expect((result as { playVsEngine?: unknown }).playVsEngine).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // ── KS-2487. sourceGame ─────────────────────────────────────────

    // ── KS-2524 / KS-2521. playVsEngine.wdlBefore / wdlAfter ─────────

    it('KS-2524: parser достаёт wdlBefore/wdlAfter из metadata', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
        wdlBefore: { w: 850, d: 130, l: 20 },
        wdlAfter: { w: 200, d: 600, l: 200 },
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-wdl',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'sacrifice playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-wdl');
      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as { playVsEngine?: typeof meta }).playVsEngine;
      expect(pve).toBeDefined();
      expect(pve!.wdlBefore).toEqual({ w: 850, d: 130, l: 20 });
      expect(pve!.wdlAfter).toEqual({ w: 200, d: 600, l: 200 });
      expect(pve!.wdlAfterBlunder).toBe(0.78);
    });

    it('KS-3136: новый puzzle с deltaW/deltaD в metadata → пробрасывается в DTO', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
        // ADR-068: новые поля. Legacy `blunderDelta` НЕ пишется.
        deltaW: 0.72,
        deltaD: 0.04,
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-new',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-new');
      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as {
        playVsEngine?: { deltaW?: number; deltaD?: number };
      }).playVsEngine;
      expect(pve).toBeDefined();
      expect(pve!.deltaW).toBeCloseTo(0.72);
      expect(pve!.deltaD).toBeCloseTo(0.04);
    });

    it('KS-3136: legacy puzzle БЕЗ deltaW/deltaD → DTO без новых полей (backward-compat)', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
        // Старый формат — есть только legacy blunderDelta.
        blunderDelta: 0.74,
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-legacy-delta',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-legacy-delta');
      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as {
        playVsEngine?: { deltaW?: number; deltaD?: number; wdlAfterBlunder?: number };
      }).playVsEngine;
      expect(pve).toBeDefined();
      // Новых полей нет — фронт работает по старому контракту через
      // wdlAfterBlunder.
      expect(pve!.deltaW).toBeUndefined();
      expect(pve!.deltaD).toBeUndefined();
      expect(pve!.wdlAfterBlunder).toBe(0.78);
    });

    it('KS-2524: legacy puzzle без wdl-объектов → wdlBefore/wdlAfter undefined', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-legacy',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-legacy');
      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as {
        playVsEngine?: {
          wdlBefore?: unknown;
          wdlAfter?: unknown;
          wdlAfterBlunder?: number;
        };
      }).playVsEngine;
      expect(pve).toBeDefined();
      expect(pve!.wdlBefore).toBeUndefined();
      expect(pve!.wdlAfter).toBeUndefined();
      expect(pve!.wdlAfterBlunder).toBe(0.78);
    });

    it('KS-2524: невалидный wdl-объект (отсутствует w) игнорируется', async () => {
      const meta = {
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
        wdlBefore: { w: 850, d: 130 }, // без l
        wdlAfter: { w: 'wat', d: 600, l: 200 }, // w не число
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-bad-wdl',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: 'playVsEngine',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        sourceMetadata: JSON.stringify(meta),
      });

      const result = await service.getPuzzle('pve-bad-wdl');
      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as {
        playVsEngine?: {
          wdlBefore?: unknown;
          wdlAfter?: unknown;
        };
      }).playVsEngine;
      expect(pve!.wdlBefore).toBeUndefined();
      expect(pve!.wdlAfter).toBeUndefined();
    });

    it('KS-2487: gameUrl (lichess) → sourceGame.pgnUrl', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-l1',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'lichess',
        solutionMode: 'forced-line',
        sourceMetadata: null,
        gameUrl: 'https://lichess.org/abcdefgh',
        sourceType: null,
        sourceId: null,
      });
      const result = await service.getPuzzle('p-l1');
      expect(result.sourceGame).toEqual({
        pgnUrl: 'https://lichess.org/abcdefgh',
      });
    });

    it('KS-2487: archive_game source → sourceGame.archiveGameId', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-g1',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'generated',
        solutionMode: 'forced-line',
        sourceMetadata: null,
        gameUrl: null,
        sourceType: 'archive_game',
        sourceId: '550e8400-e29b-41d4-a716-446655440000',
      });
      const result = await service.getPuzzle('p-g1');
      expect(result.sourceGame).toEqual({
        archiveGameId: '550e8400-e29b-41d4-a716-446655440000',
      });
    });

    it('KS-2487: PGN headers в sourceMetadata → white/black/event/date/result', async () => {
      const meta = {
        headers: {
          White: 'Carlsen, M.',
          Black: 'Nepomniachtchi, I.',
          Event: 'World Championship 2026',
          Date: '2026.04.20',
          Result: '1-0',
        },
      };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-h1',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'generated',
        solutionMode: 'forced-line',
        sourceMetadata: JSON.stringify(meta),
        gameUrl: null,
        sourceType: 'archive_game',
        sourceId: 'aaaa',
      });
      const result = await service.getPuzzle('p-h1');
      expect(result.sourceGame).toEqual({
        white: 'Carlsen, M.',
        black: 'Nepomniachtchi, I.',
        event: 'World Championship 2026',
        date: '2026.04.20',
        result: '1-0',
        archiveGameId: 'aaaa',
      });
    });

    it('KS-2487: top-level white/black в sourceMetadata тоже работают', async () => {
      const meta = { white: 'Alice', black: 'Bob', date: '2026-04-01' };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-h2',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'generated',
        solutionMode: 'forced-line',
        sourceMetadata: JSON.stringify(meta),
        gameUrl: null,
        sourceType: null,
        sourceId: null,
      });
      const result = await service.getPuzzle('p-h2');
      expect(result.sourceGame).toEqual({
        white: 'Alice',
        black: 'Bob',
        date: '2026-04-01',
      });
    });

    it('KS-2487: невалидный result в sourceMetadata игнорируется', async () => {
      const meta = { white: 'A', black: 'B', result: 'win' };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-bad',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'generated',
        solutionMode: 'forced-line',
        sourceMetadata: JSON.stringify(meta),
        gameUrl: null,
        sourceType: null,
        sourceId: null,
      });
      const result = await service.getPuzzle('p-bad');
      expect(result.sourceGame).toEqual({ white: 'A', black: 'B' });
      expect(
        (result.sourceGame as { result?: string } | undefined)?.result,
      ).toBeUndefined();
    });

    it('KS-2487: пазл без gameUrl/sourceId/headers → sourceGame не выставляется', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-empty',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'lichess',
        solutionMode: 'forced-line',
        sourceMetadata: null,
        gameUrl: null,
        sourceType: null,
        sourceId: null,
      });
      const result = await service.getPuzzle('p-empty');
      expect(
        (result as { sourceGame?: unknown }).sourceGame,
      ).toBeUndefined();
    });

    it('KS-2487: combined — headers + archiveGameId + pgnUrl', async () => {
      const meta = { White: 'A', Black: 'B', Event: 'Tata Steel' };
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-mix',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'generated',
        solutionMode: 'forced-line',
        sourceMetadata: JSON.stringify(meta),
        gameUrl: 'https://lichess.org/xxx',
        sourceType: 'archive_game',
        sourceId: 'arch-123',
      });
      const result = await service.getPuzzle('p-mix');
      expect(result.sourceGame).toEqual({
        white: 'A',
        black: 'B',
        event: 'Tata Steel',
        archiveGameId: 'arch-123',
        pgnUrl: 'https://lichess.org/xxx',
      });
    });

    it('KS-2487: невалидный JSON sourceMetadata → headers пропускаются, gameUrl остаётся', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'p-broken',
        fen: 'fen',
        moves: 'e2e4',
        rating: 1500,
        themes: '',
        source: 'lichess',
        solutionMode: 'forced-line',
        sourceMetadata: '{not json',
        gameUrl: 'https://lichess.org/yyy',
        sourceType: null,
        sourceId: null,
      });
      const result = await service.getPuzzle('p-broken');
      expect(result.sourceGame).toEqual({ pgnUrl: 'https://lichess.org/yyy' });
    });

    it('KS-2665: play-vs-engine без halfMovesN — берётся серверный default 6', async () => {
      // KS-2465 раньше требовал halfMovesN в meta и при отсутствии
      // делал fallback forced-line. KS-2665: ADR-050 §3 #5 явно
      // оговаривает halfMovesN как server-default — фронт-генератор
      // его НЕ передаёт. Теперь resolver подставляет PUZZLE_GEN_DEFAULTS.
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-partial',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: '',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        // halfMovesN отсутствует — теперь это нормально.
        sourceMetadata: JSON.stringify({
          blunderMove: 'e2e4',
          wdlAfterBlunder: 0.7,
          winThreshold: 0.5,
          failThreshold: 0.0,
        }),
      });

      const result = await service.getPuzzle('pve-partial');

      expect(result.solutionMode).toBe('play-vs-engine');
      const pve = (result as { playVsEngine?: { halfMovesN: number; blunderMove: string } }).playVsEngine;
      expect(pve).toBeDefined();
      expect(pve!.halfMovesN).toBe(6);
      expect(pve!.blunderMove).toBe('e2e4');
    });
  });

  // ── KS-2465 / ADR-044 §5.4. submitAttempt + play-vs-engine ───────

  describe('KS-2465: submitAttempt в режиме play-vs-engine', () => {
    const playVsEngineMeta = {
      blunderMove: 'e2e4',
      wdlAfterBlunder: 0.78,
      winThreshold: 0.5,
      failThreshold: 0.0,
      halfMovesN: 6,
    };
    const pvePuzzle = {
      id: 'pve1',
      fen: 'fen-after-blunder',
      moves: '',
      rating: 1700,
      themes: 'playVsEngine',
      source: 'generated',
      solutionMode: 'play-vs-engine',
      sourceMetadata: JSON.stringify(playVsEngineMeta),
    };

    it('submitAttempt принимает halfMovesPlayed/finalWdl/reason и не падает', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(pvePuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1512,
        puzzleRatingAfter: 1690,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1512 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.submitAttempt(
        'user-1',
        'pve1',
        true,
        7000,
        undefined,
        0,
        { halfMovesPlayed: 6, finalWdl: 0.82, reason: 'win' },
      );

      expect(result.solved).toBe(true);
      expect(result.userRatingAfter).toBe(1512);
      // play-vs-engine поля НЕ записываются в puzzleAttempt — только лог.
      const createCall = prisma.puzzleAttempt.create.mock.calls[0]?.[0];
      expect(createCall.data).not.toHaveProperty('halfMovesPlayed');
      expect(createCall.data).not.toHaveProperty('finalWdl');
      expect(createCall.data).not.toHaveProperty('reason');
    });

    it('validatePlayerSide пропускает (early-return) для play-vs-engine — solved не переопределяется', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(pvePuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1512,
        puzzleRatingAfter: 1690,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1512 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      // userMoves заведомо «нелегальные» для классической валидации
      // (без setup-хода, неверная сторона). Для play-vs-engine это
      // должно игнорироваться.
      const result = await service.submitAttempt(
        'user-1',
        'pve1',
        true,
        7000,
        'a1a8 h1h8',
        0,
        { halfMovesPlayed: 6, finalWdl: 0.6, reason: 'win' },
      );

      expect(result.solved).toBe(true);
    });

    it('Glicko-2 update идёт через стандартный solved boolean (без play-vs-engine специфики)', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(pvePuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1480,
        puzzleRatingAfter: 1715,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1480 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.submitAttempt(
        'user-1',
        'pve1',
        false,
        4000,
        undefined,
        0,
        { halfMovesPlayed: 3, finalWdl: -0.4, reason: 'lose-wdl' },
      );

      expect(ratingService.applyRatingChange).toHaveBeenCalledWith(
        'user-1',
        'pve1',
        false,
      );
    });
  });

  // ── KS-2717 / ADR-056. Server-trust submitAttempt с moves[] ──────

  describe('KS-2717: submitAttempt PVE с per-move snapshot', () => {
    const pvePuzzle = {
      id: 'pve-2',
      // Лёгкая позиция: ход белых, e2-e4 / e2-e3 — оба легальны.
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: '',
      rating: 1700,
      themes: 'playVsEngine',
      source: 'generated',
      solutionMode: 'play-vs-engine',
      sourceMetadata: JSON.stringify({
        blunderMove: 'e2e4',
        wdlAfterBlunder: 0.78,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      }),
    };

    function setupPveMocks() {
      prisma.puzzle.findUnique.mockResolvedValue(pvePuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1500,
        puzzleRatingBefore: 1700,
        puzzleRatingAfter: 1700,
      });
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ratingPuzzle: 1500,
        ratingPuzzleDev: 80,
        puzzleStreak: 0,
      });
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      // Транзакция: имитируем tx через объект с теми же методами.
      const txState: {
        attempt?: any;
        precision?: any;
        moves?: any[];
      } = {};
      prisma.$transaction = jest.fn(
        async (cb: (tx: any) => Promise<unknown>) => {
          const tx = {
            puzzleAttempt: {
              create: jest.fn(async ({ data }: any) => {
                txState.attempt = { id: 'attempt-uuid', ...data };
                return { id: 'attempt-uuid' };
              }),
            },
            precisionAttempt: {
              create: jest.fn(async ({ data }: any) => {
                txState.precision = data;
                return data;
              }),
            },
            precisionAttemptMove: {
              createMany: jest.fn(async ({ data }: any) => {
                txState.moves = data;
                return { count: data.length };
              }),
            },
          };
          return cb(tx).then(() => undefined);
        },
      );
      return txState;
    }

    it('создаёт PrecisionAttempt + PrecisionAttemptMove[] для PVE с moves', async () => {
      const tx = setupPveMocks();
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4', // best — best
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
        {
          ply: 2,
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          playedUci: 'g1f3',
          bestUci: 'b1c3', // не best
          cpBefore: 35,
          cpAfter: 25, // cpLoss=10 → good
          depth: 14,
        },
      ];

      const result = await service.submitAttempt(
        'user-1',
        'pve-2',
        true,
        7000,
        undefined,
        0,
        {
          halfMovesPlayed: 2,
          finalWdl: 0.6,
          initialWdl: 0.5,
          reason: 'win',
          moves,
        } as any,
      );

      expect(result.solved).toBe(true);
      // Транзакция вызвана.
      expect(prisma.$transaction).toHaveBeenCalled();
      // KS-3020 / ADR-066 §3.4: после перехода на WDL-loss-классификацию
      // оба хода с малым cp-изменением (30→35, 35→25) попадают в `best`
      // через cp-fallback: winPctFromCp(35)≈53.21, winPctFromCp(25)≈52.30,
      // loss_E=0.0091 ≤ 0.02 → best. Раньше cpLoss=10 → good. Это и есть
      // одна из «3 точек сдвига» из ADR-066 §5.1, утверждённая пользователем.
      expect(tx.precision).toMatchObject({
        attemptId: 'attempt-uuid',
        bestMovesCount: 2,
        goodMovesCount: 0,
        inaccuraciesCount: 0,
        mistakesCount: 0,
        blundersCount: 0,
        firstMistakePly: null,
        accuracyPercent: 100,
        wdlAtStartSigned: 0.5,
        wdlAtEndSigned: 0.6,
        endReason: 'win',
        halfMovesPlayed: 2,
      });
      // 2 записи в moves.
      expect(tx.moves).toHaveLength(2);
      expect(tx.moves![0]).toMatchObject({
        attemptId: 'attempt-uuid',
        ply: 1,
        playedUci: 'e2e4',
        classification: 'best',
      });
      // KS-3020: g1f3 vs PV1 b1c3 → не best, но cp-loss мал → best (через WDL).
      expect(tx.moves![1]).toMatchObject({
        ply: 2,
        playedUci: 'g1f3',
        classification: 'best',
      });
    });

    it('игнорирует клиентский accuracy: serverside пересчёт', async () => {
      const tx = setupPveMocks();
      // Клиент пытается передать клиентский accuracy через добавочное
      // поле (имитация манипуляции). Серверный расчёт: 1 blunder = 0%.
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'd2d4',
          cpBefore: 100,
          cpAfter: -200, // cpLoss=300 → blunder
          depth: 14,
          // потенциально подделанные клиентом поля — игнорируются.
          accuracyPercent: 100,
          classification: 'best',
        },
      ];

      await service.submitAttempt(
        'user-1',
        'pve-2',
        false,
        4000,
        undefined,
        0,
        {
          halfMovesPlayed: 1,
          finalWdl: -0.5,
          initialWdl: 0.4,
          reason: 'lose-wdl',
          moves,
        } as any,
      );

      expect(tx.precision).toMatchObject({
        bestMovesCount: 0,
        blundersCount: 1,
        accuracyPercent: 0,
        firstMistakePly: 1,
      });
      expect(tx.moves![0].classification).toBe('blunder');
      // KS-3033: MIN_HALF_MOVES_FOR_SCORE понижен 2→1.
      // 1 ход с blunder (cp 100/-200, loss_E через cp ≈ 0.27) →
      // composite≈29 → 1★. Раньше тут было null.
      expect(tx.precision.score).toBe(1);
      expect(tx.precision.scorePct).toBeGreaterThan(0);
      expect(tx.precision.scorePct).toBeLessThan(50);
    });

    // ── KS-2999 / ADR-065: server-side score ────────────────────────

    it('KS-2999: 5 best + 1 blunder с WDL-loss=50% → score=2, scorePct=60 (cap blunder)', async () => {
      // Контрольный кейс ADR-065 §4.3 #6: композит композит даёт
      // ≈ 60.4, но worst-class cap (blunder → 60) опускает ровно к 60.
      // Маппинг: 60 ∈ [50,70) → ★★.
      const tx = setupPveMocks();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      // 5 best-ходов: WDL не меняется (E=1.0 везде) → accuracy=100.
      const bestUcis: string[] = ['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b1c3'];
      const moves: any[] = bestUcis.map((uci, i) => ({
        ply: i + 1,
        fenBefore: startFen,
        playedUci: uci,
        bestUci: uci, // совпадает → classifyMove() → 'best'
        cpBefore: 30,
        cpAfter: 30,
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 1000, d: 0, l: 0 },
        depth: 14,
      }));
      // Финальный ход — blunder с WDL loss=50% (E=1.0 → 0.5) →
      // accuracy_move ≈ 8.5; cpLoss=300 → classifyMove='blunder'.
      moves.push({
        ply: 6,
        fenBefore: startFen,
        playedUci: 'g2g4',
        bestUci: 'e2e4',
        cpBefore: 100,
        cpAfter: -200,
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 500, d: 0, l: 500 },
        depth: 14,
      });

      await service.submitAttempt('user-1', 'pve-2', false, 8000, undefined, 0, {
        halfMovesPlayed: 6,
        finalWdl: 0.0,
        initialWdl: 1.0,
        reason: 'lose-wdl',
        moves,
      } as any);

      // Аггрегат счётчиков (унаследованный accuracyPercent — отдельная
      // метрика, KS-2999 её не трогает): 5 best + 1 blunder = 5/6 ≈ 83.33%.
      expect(tx.precision.bestMovesCount).toBe(5);
      expect(tx.precision.blundersCount).toBe(1);
      expect(tx.precision.accuracyPercent).toBeCloseTo(83.33, 1);
      // KS-2999: scorePct упирается в cap=60, stars=2.
      expect(tx.precision.scorePct).toBe(60);
      expect(tx.precision.score).toBe(2);
    });

    it('KS-2999: 2 best-хода с WDL=1.0 → score=5, scorePct≈100', async () => {
      const tx = setupPveMocks();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const moves = [
        {
          ply: 1,
          fenBefore: startFen,
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 30,
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 1000, d: 0, l: 0 },
          depth: 14,
        },
        {
          ply: 2,
          fenBefore: startFen,
          playedUci: 'd2d4',
          bestUci: 'd2d4',
          cpBefore: 30,
          cpAfter: 30,
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 1000, d: 0, l: 0 },
          depth: 14,
        },
      ];

      await service.submitAttempt('user-1', 'pve-2', true, 4000, undefined, 0, {
        halfMovesPlayed: 2,
        finalWdl: 1.0,
        initialWdl: 1.0,
        reason: 'win',
        moves,
      } as any);

      expect(tx.precision.score).toBe(5);
      expect(tx.precision.scorePct).toBeCloseTo(100, 1);
    });

    // ── KS-3021 / ADR-066: server-side classifyMove на WDL ─────────

    it('KS-3021 UX-bug repro: WDL не меняется, cp прыгает → все best', async () => {
      // Сценарий из KS-3019: «в выигранной позиции cp скачет на сотни
      // пунктов между ходами, WDL остаётся 100/0/0». До ADR-066 cp-loss
      // помечал такие ходы как mistake (`?`). После ADR-066 → best.
      const tx = setupPveMocks();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const moves = [
        {
          ply: 1,
          fenBefore: startFen,
          playedUci: 'e2e4',
          bestUci: 'd2d4', // НЕ совпадает с PV1
          cpBefore: 1500,
          cpAfter: 1300, // cp-loss=200 → раньше mistake
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 1000, d: 0, l: 0 }, // WDL не упал → best
          depth: 14,
        },
        {
          ply: 2,
          fenBefore: startFen,
          playedUci: 'g1f3',
          bestUci: 'b1c3', // НЕ PV1
          cpBefore: 1300,
          cpAfter: 1100, // cp-loss=200 → раньше mistake
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 1000, d: 0, l: 0 },
          depth: 14,
        },
      ];

      await service.submitAttempt('user-1', 'pve-2', true, 5000, undefined, 0, {
        halfMovesPlayed: 2,
        finalWdl: 1.0,
        initialWdl: 1.0,
        reason: 'win',
        moves,
      } as any);

      // Все ходы — best (через mate-edge wdl_after.w > 950).
      expect(tx.precision.bestMovesCount).toBe(2);
      expect(tx.precision.mistakesCount).toBe(0);
      expect(tx.precision.accuracyPercent).toBe(100);
      expect(tx.moves![0].classification).toBe('best');
      expect(tx.moves![1].classification).toBe('best');
    });

    it('KS-3021: mid-mistake (loss_E=0.20) на нейтральной позиции → mistake', async () => {
      // Стартовая E=0.7, после хода E=0.5 → loss_E=0.20. Mate-edge не
      // активен (w/l < 950). classifyMove должен вернуть mistake.
      const tx = setupPveMocks();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const moves = [
        {
          ply: 1,
          fenBefore: startFen,
          playedUci: 'e2e4',
          bestUci: 'd2d4', // НЕ PV1
          cpBefore: 100,
          cpAfter: 0,
          wdlBefore: { w: 500, d: 400, l: 100 }, // E=0.7
          wdlAfter: { w: 300, d: 400, l: 300 }, // E=0.5 → loss=0.20
          depth: 14,
        },
        {
          ply: 2,
          fenBefore: startFen,
          playedUci: 'g1f3',
          bestUci: 'g1f3', // best
          cpBefore: 0,
          cpAfter: 0,
          wdlBefore: { w: 300, d: 400, l: 300 },
          wdlAfter: { w: 300, d: 400, l: 300 },
          depth: 14,
        },
      ];

      await service.submitAttempt('user-1', 'pve-2', false, 6000, undefined, 0, {
        halfMovesPlayed: 2,
        finalWdl: 0.0,
        initialWdl: 0.4,
        reason: 'lose-wdl',
        moves,
      } as any);

      expect(tx.precision.mistakesCount).toBe(1);
      expect(tx.precision.bestMovesCount).toBe(1);
      expect(tx.precision.firstMistakePly).toBe(1);
      expect(tx.moves![0].classification).toBe('mistake');
      expect(tx.moves![1].classification).toBe('best');
    });

    it('KS-3021: mate-edge wdl_after.l > 950 → blunder', async () => {
      // Игрок «сходил под мат»: WDL после хода почти полностью loss.
      const tx = setupPveMocks();
      const startFen =
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const moves = [
        {
          ply: 1,
          fenBefore: startFen,
          playedUci: 'e2e4',
          bestUci: 'd2d4',
          cpBefore: 50,
          cpAfter: -200,
          wdlBefore: { w: 400, d: 400, l: 200 },
          wdlAfter: { w: 0, d: 30, l: 970 }, // l > 950 → mate-edge blunder
          depth: 14,
        },
      ];

      await service.submitAttempt('user-1', 'pve-2', false, 3000, undefined, 0, {
        halfMovesPlayed: 1,
        finalWdl: -1.0,
        initialWdl: 0.2,
        reason: 'lose-mate',
        moves,
      } as any);

      expect(tx.precision.blundersCount).toBe(1);
      expect(tx.moves![0].classification).toBe('blunder');
    });

    // ── KS-2740: sparse ply (user-only ходы) ────────────────────────

    it('KS-2740: sparse ply 1,3,5,... принимается (user-moves в PVE)', async () => {
      const tx = setupPveMocks();
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
        {
          ply: 3, // engine сходил между; пропуск ply=2 нормален
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          playedUci: 'g1f3',
          bestUci: 'b1c3',
          cpBefore: 35,
          cpAfter: 25,
          depth: 14,
        },
        {
          ply: 5,
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 1 3',
          playedUci: 'f1c4',
          bestUci: 'f1c4',
          cpBefore: 25,
          cpAfter: 30,
          depth: 14,
        },
      ];

      const result = await service.submitAttempt(
        'user-1',
        'pve-2',
        true,
        7000,
        undefined,
        0,
        {
          halfMovesPlayed: 3,
          finalWdl: 0.6,
          initialWdl: 0.5,
          reason: 'win',
          moves,
        } as any,
      );

      expect(result.solved).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
      // Все 3 user-хода сохранены с их sparse ply.
      expect(tx.moves).toHaveLength(3);
      expect(tx.moves!.map((m: any) => m.ply)).toEqual([1, 3, 5]);
      // halfMovesPlayed считается по числу moves, не по max(ply).
      expect(tx.precision).toMatchObject({ halfMovesPlayed: 3 });
    });

    it('KS-2740: ply убывает → 400 (не должно происходить с фронта)', async () => {
      setupPveMocks();
      const moves = [
        {
          ply: 3,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
        {
          ply: 1, // убывание
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          playedUci: 'g1f3',
          bestUci: 'g1f3',
          cpBefore: 30,
          cpAfter: 30,
          depth: 14,
        },
      ];

      await expect(
        service.submitAttempt('user-1', 'pve-2', true, 7000, undefined, 0, {
          halfMovesPlayed: 2,
          reason: 'win',
          moves,
        } as any),
      ).rejects.toThrow(/strictly increase/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('KS-2740: дубликат ply → 400', async () => {
      setupPveMocks();
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
        {
          ply: 1, // дубликат
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          playedUci: 'g1f3',
          bestUci: 'g1f3',
          cpBefore: 30,
          cpAfter: 30,
          depth: 14,
        },
      ];

      await expect(
        service.submitAttempt('user-1', 'pve-2', true, 7000, undefined, 0, {
          halfMovesPlayed: 2,
          reason: 'win',
          moves,
        } as any),
      ).rejects.toThrow(/strictly increase/);
    });

    it('KS-2740: ply=0 → 400 (must be ≥ 1)', async () => {
      setupPveMocks();
      const moves = [
        {
          ply: 0,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
      ];

      await expect(
        service.submitAttempt('user-1', 'pve-2', true, 7000, undefined, 0, {
          halfMovesPlayed: 1,
          reason: 'win',
          moves,
        } as any),
      ).rejects.toThrow(/invalid ply/);
    });

    it('KS-2740: sequential ply 1,2,3 (старый формат) — тоже принимается', async () => {
      const tx = setupPveMocks();
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          playedUci: 'e2e4',
          bestUci: 'e2e4',
          cpBefore: 30,
          cpAfter: 35,
          depth: 14,
        },
        {
          ply: 2,
          fenBefore:
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          playedUci: 'g1f3',
          bestUci: 'g1f3',
          cpBefore: 30,
          cpAfter: 30,
          depth: 14,
        },
      ];

      await service.submitAttempt(
        'user-1',
        'pve-2',
        true,
        7000,
        undefined,
        0,
        { halfMovesPlayed: 2, reason: 'win', moves } as any,
      );

      expect(tx.moves).toHaveLength(2);
      expect(tx.moves!.map((m: any) => m.ply)).toEqual([1, 2]);
    });

    it('нелегальный UCI → 400, ничего не пишется', async () => {
      setupPveMocks();
      const moves = [
        {
          ply: 1,
          fenBefore:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          // Нелегальный ход с пустой клетки.
          playedUci: 'e5e6',
          bestUci: 'e2e4',
          cpBefore: 0,
          cpAfter: 0,
          depth: 14,
        },
      ];

      await expect(
        service.submitAttempt('user-1', 'pve-2', true, 7000, undefined, 0, {
          halfMovesPlayed: 1,
          reason: 'win',
          moves,
        } as any),
      ).rejects.toThrow(/illegal move/);

      // PrecisionAttempt НЕ создан (транзакция не достигла create).
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('PVE без moves[] → старый путь, PrecisionAttempt не создаётся', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(pvePuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1500,
        puzzleRatingBefore: 1700,
        puzzleRatingAfter: 1700,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      prisma.$transaction = jest.fn();

      await service.submitAttempt(
        'user-1',
        'pve-2',
        true,
        7000,
        undefined,
        0,
        { halfMovesPlayed: 6, finalWdl: 0.6, reason: 'win' },
      );

      // Транзакция не вызывается (нет moves).
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // Обычный create (без precision).
      expect(prisma.puzzleAttempt.create).toHaveBeenCalled();
    });

    it('forced-line attempt с (ошибочно переданными) moves[] → moves игнорируются, старый путь', async () => {
      const flPuzzle = {
        ...pvePuzzle,
        id: 'fl-1',
        solutionMode: 'forced-line',
        moves: 'e2e4 e7e5',
      };
      prisma.puzzle.findUnique.mockResolvedValue(flPuzzle);
      ratingService.applyRatingChange.mockResolvedValue({
        userRatingBefore: 1500,
        userRatingAfter: 1510,
        puzzleRatingBefore: 1500,
        puzzleRatingAfter: 1490,
      });
      prisma.puzzleAttempt.create.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1510 });
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      prisma.$transaction = jest.fn();

      await service.submitAttempt('user-1', 'fl-1', true, 5000, undefined, 0, {
        moves: [
          {
            ply: 1,
            fenBefore:
              'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            playedUci: 'e2e4',
            bestUci: 'e2e4',
            cpBefore: 30,
            cpAfter: 35,
            depth: 14,
          },
        ],
      } as any);

      // forced-line → не идёт в персистенс PVE (даже с moves).
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.puzzleAttempt.create).toHaveBeenCalled();
    });
  });

  describe('KS-299: no repeated attempted puzzles', () => {
    describe('getNextPuzzle — excludes already-solved attempts', () => {
      // KS-2735 (was KS-299): primary запрос теперь исключает попытки
      // за 7 дней (recent-7d window), а не «solved=true» (старое
      // поведение лежит в 3-м уровне fallback'а каскада).
      it('should pass userId to NOT EXISTS clause (recent-7d window) via raw SQL', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1200 });
        prisma.$queryRawUnsafe.mockResolvedValue([
          { id: 'p3', fen: 'fen', moves: 'e2e4', rating: 1200, themes: 'fork', source: 'lichess', game_url: null, opening_tags: null },
        ]);

        const result = await service.getNextPuzzle('user-1');

        expect(result.id).toBe('p3');
        expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
        const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
        expect(sql).toContain('NOT EXISTS');
        // KS-2735: primary имеет 7-дневное окно, не solved-only.
        expect(sql).toContain("INTERVAL '7 days'");
        expect(params).toEqual(expect.arrayContaining(['user-1']));
      });

      it('should not repeat puzzles across consecutive calls', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1200 });

        // First call: raw query returns p1
        prisma.$queryRawUnsafe.mockResolvedValueOnce([
          { id: 'p1', fen: 'fen1', moves: 'e2e4', rating: 1200, themes: 'fork', source: 'lichess', game_url: null, opening_tags: null },
        ]);
        const first = await service.getNextPuzzle('user-1');
        expect(first.id).toBe('p1');

        // Second call: raw query returns p2 (solved p1 filtered out by NOT EXISTS)
        prisma.$queryRawUnsafe.mockResolvedValueOnce([
          { id: 'p2', fen: 'fen2', moves: 'd2d4', rating: 1200, themes: 'pin', source: 'lichess', game_url: null, opening_tags: null },
        ]);
        const second = await service.getNextPuzzle('user-1');
        expect(second.id).toBe('p2');
        expect(second.id).not.toBe(first.id);
      });
    });

    describe('getNextPuzzleByTheme — excludes all attempted', () => {
      it('should not return previously failed puzzles in theme mode', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1300 });
        // p1 was failed, p2 was solved — both excluded
        prisma.puzzleAttempt.findMany.mockResolvedValue([
          { puzzleId: 'p1' },
          { puzzleId: 'p2' },
        ]);
        prisma.puzzle.findMany.mockResolvedValue([
          { id: 'p3', fen: 'fen3', moves: 'e2e4', rating: 1300, themes: 'pin' },
        ]);

        const result = await service.getNextPuzzleByTheme('user-1', 'pin');

        expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith({
          where: { userId: 'user-1' },
          select: { puzzleId: true },
          distinct: ['puzzleId'],
        });
        expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: { notIn: ['p1', 'p2'] },
              themes: { contains: 'pin' },
            }),
          }),
        );
        expect(result.id).toBe('p3');
      });
    });

    describe('boundary: all puzzles in theme attempted', () => {
      it('should throw NotFoundException when all theme puzzles are attempted', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1400 });
        // All puzzles in this theme were attempted
        prisma.puzzleAttempt.findMany.mockResolvedValue([
          { puzzleId: 'p1' },
          { puzzleId: 'p2' },
          { puzzleId: 'p3' },
        ]);
        // No puzzles left after exclusion
        prisma.puzzle.findMany.mockResolvedValue([]);

        await expect(
          service.getNextPuzzleByTheme('user-1', 'endgame'),
        ).rejects.toThrow(NotFoundException);
      });

      it('should use fallback in getNextPuzzle when primary rating-range query is empty', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
        // Primary raw query returns empty → service runs fallback raw query without rating filter.
        prisma.$queryRawUnsafe
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'p99', fen: 'fen99', moves: 'a2a4', rating: 800, themes: 'mate', source: 'lichess', game_url: null, opening_tags: null },
          ]);

        const result = await service.getNextPuzzle('user-1');

        expect(result.id).toBe('p99');
        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      });

      it('should throw NotFoundException when absolutely no puzzles left', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
        // Both primary and fallback raw queries return empty.
        prisma.$queryRawUnsafe
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);

        await expect(service.getNextPuzzle('user-1')).rejects.toThrow(
          NotFoundException,
        );
      });
    });
  });

  // ── KS-2494 / ADR-046 §5.4. getUserAttempts.solutionMode ──────────

  describe('getUserAttempts (KS-2494)', () => {
    it('включает puzzle.solutionMode в select', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);

      await service.getUserAttempts('user-1', 20, 0);

      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            puzzle: {
              select: expect.objectContaining({
                id: true,
                solutionMode: true,
              }),
            },
          },
        }),
      );
    });

    it('возвращает массив attempts с puzzle.solutionMode', async () => {
      const mockAttempts = [
        {
          id: 'a1',
          userId: 'user-1',
          puzzleId: 'p1',
          solved: true,
          puzzle: {
            id: 'p1',
            fen: 'fen1',
            rating: 1500,
            themes: 'mate',
            source: 'lichess',
            solutionMode: 'forced-line',
          },
        },
        {
          id: 'a2',
          userId: 'user-1',
          puzzleId: 'p2',
          solved: false,
          puzzle: {
            id: 'p2',
            fen: 'fen2',
            rating: 1700,
            themes: 'crushing playVsEngine',
            source: 'generated',
            solutionMode: 'play-vs-engine',
          },
        },
      ];
      prisma.puzzleAttempt.findMany.mockResolvedValue(mockAttempts);

      const result = await service.getUserAttempts('user-1', 20, 0);

      expect(result).toHaveLength(2);
      expect(result[0].puzzle.solutionMode).toBe('forced-line');
      expect(result[1].puzzle.solutionMode).toBe('play-vs-engine');
    });

    it('пробрасывает take/skip без изменений', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);

      await service.getUserAttempts('user-1', 5, 10);

      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          take: 5,
          skip: 10,
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  // ── KS-2493 / ADR-046 §5.3. getStats.byMode ───────────────────────

  describe('getStats — byMode (KS-2493)', () => {
    function setupStatsMocks(byModeRows: Array<{
      solution_mode: string | null;
      attempts: number;
      solved: number;
      avg_rating: number | null;
      avg_time_ms: number | null;
    }>) {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ratingPuzzle: 1500,
        ratingPuzzleDev: 80,
        puzzleStreak: 3,
      });
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.puzzleRushScore.findFirst.mockResolvedValue(null);
      prisma.puzzleAttempt.aggregate.mockResolvedValue({ _avg: { timeMs: null } });
      prisma.puzzleRatingSnapshot.findUnique.mockResolvedValue(null);
      // BigInt → Number в service.
      prisma.$queryRaw.mockResolvedValue(
        byModeRows.map((r) => ({
          ...r,
          attempts: BigInt(r.attempts),
          solved: BigInt(r.solved),
        })),
      );
    }

    it('возвращает обе ключа byMode даже когда попыток нет', async () => {
      setupStatsMocks([]);

      const r = await service.getStats('user-1');

      expect(r.byMode).toEqual({
        'forced-line': {
          attempts: 0,
          solved: 0,
          accuracy: 0,
          avgRating: null,
          avgTimeMs: 0,
        },
        'play-vs-engine': {
          attempts: 0,
          solved: 0,
          accuracy: 0,
          avgRating: null,
          avgTimeMs: 0,
        },
      });
    });

    it('считает accuracy / avgRating / avgTimeMs для forced-line', async () => {
      setupStatsMocks([
        {
          solution_mode: 'forced-line',
          attempts: 10,
          solved: 7,
          avg_rating: 1450.5,
          avg_time_ms: 12345.6,
        },
      ]);

      const r = await service.getStats('user-1');

      expect(r.byMode['forced-line']).toEqual({
        attempts: 10,
        solved: 7,
        accuracy: 70,
        avgRating: 1451, // округление
        avgTimeMs: 12346,
      });
      // Второй режим — пустая запись.
      expect(r.byMode['play-vs-engine'].attempts).toBe(0);
      expect(r.byMode['play-vs-engine'].avgRating).toBeNull();
    });

    it('обе режима заполнены — оба корректно', async () => {
      setupStatsMocks([
        {
          solution_mode: 'forced-line',
          attempts: 8,
          solved: 4,
          avg_rating: 1500,
          avg_time_ms: 10000,
        },
        {
          solution_mode: 'play-vs-engine',
          attempts: 4,
          solved: 1,
          avg_rating: 1700,
          avg_time_ms: 30000,
        },
      ]);

      const r = await service.getStats('user-1');

      expect(r.byMode['forced-line']).toEqual({
        attempts: 8,
        solved: 4,
        accuracy: 50,
        avgRating: 1500,
        avgTimeMs: 10000,
      });
      expect(r.byMode['play-vs-engine']).toEqual({
        attempts: 4,
        solved: 1,
        accuracy: 25,
        avgRating: 1700,
        avgTimeMs: 30000,
      });
    });

    it('NULL solution_mode → попадает в forced-line (старые пазлы до миграции)', async () => {
      setupStatsMocks([
        {
          solution_mode: null,
          attempts: 5,
          solved: 3,
          avg_rating: 1400,
          avg_time_ms: 8000,
        },
      ]);

      const r = await service.getStats('user-1');
      expect(r.byMode['forced-line'].attempts).toBe(5);
      expect(r.byMode['forced-line'].solved).toBe(3);
      expect(r.byMode['forced-line'].accuracy).toBe(60);
    });

    it('неожиданный solution_mode игнорируется и попадает в forced-line bucket', async () => {
      // Защита от мусорных данных в БД (например, 'unknown' или старый
      // тег). По дизайну допускаем только 2 режима — fallback в forced-line.
      setupStatsMocks([
        {
          solution_mode: 'wat',
          attempts: 2,
          solved: 0,
          avg_rating: 1000,
          avg_time_ms: 1000,
        },
      ]);

      const r = await service.getStats('user-1');
      expect(r.byMode['forced-line'].attempts).toBe(2);
      expect(r.byMode['play-vs-engine'].attempts).toBe(0);
    });

    it('avgRating round-trip: NULL avg_rating → null, числовое → integer', async () => {
      setupStatsMocks([
        {
          solution_mode: 'play-vs-engine',
          attempts: 1,
          solved: 0,
          avg_rating: null,
          avg_time_ms: null,
        },
      ]);

      const r = await service.getStats('user-1');
      expect(r.byMode['play-vs-engine'].avgRating).toBeNull();
      expect(r.byMode['play-vs-engine'].avgTimeMs).toBe(0);
      expect(r.byMode['play-vs-engine'].accuracy).toBe(0);
    });

    // ── KS-2716 / ADR-055 B1. Top-level forced-line filter ───────────

    it('KS-2716: top-level totalAttempted/totalSolved/avgTime фильтруют solution_mode=forced-line', async () => {
      setupStatsMocks([]);

      await service.getStats('user-1');

      // Первый puzzleAttempt.count — totalAttempted; второй — totalSolved.
      const countCalls = prisma.puzzleAttempt.count.mock.calls;
      expect(countCalls.length).toBe(2);
      // Каждый count должен иметь relation-фильтр puzzle.solutionMode.
      for (const [arg] of countCalls) {
        expect(arg.where).toMatchObject({
          userId: 'user-1',
          puzzle: { is: { solutionMode: 'forced-line' } },
        });
      }
      // aggregate (avg timeMs) — то же самое.
      expect(prisma.puzzleAttempt.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            puzzle: { is: { solutionMode: 'forced-line' } },
          },
          _avg: { timeMs: true },
        }),
      );
    });
  });
});
