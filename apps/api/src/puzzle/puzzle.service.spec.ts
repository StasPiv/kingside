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
      },
      puzzleRushScore: {
        findFirst: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
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

    it('KS-2465: play-vs-engine без обязательных полей метаданных → fallback forced-line', async () => {
      const warnSpy = jest
        .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      prisma.puzzle.findUnique.mockResolvedValue({
        id: 'pve-partial',
        fen: 'fen',
        moves: '',
        rating: 1700,
        themes: '',
        source: 'generated',
        solutionMode: 'play-vs-engine',
        // halfMovesN отсутствует
        sourceMetadata: JSON.stringify({
          blunderMove: 'e2e4',
          wdlAfterBlunder: 0.7,
          winThreshold: 0.5,
          failThreshold: 0.0,
        }),
      });

      const result = await service.getPuzzle('pve-partial');

      expect(result.solutionMode).toBe('forced-line');
      expect((result as { playVsEngine?: unknown }).playVsEngine).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
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

  describe('KS-299: no repeated attempted puzzles', () => {
    describe('getNextPuzzle — excludes already-solved attempts', () => {
      // getNextPuzzle uses $queryRawUnsafe with a NOT EXISTS clause that filters on
      // pa.solved = true. We verify the userId is passed as a SQL parameter so the
      // NOT EXISTS condition is applied for the current user.
      it('should pass userId to NOT EXISTS clause (solved filter) via raw SQL', async () => {
        prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1200 });
        prisma.$queryRawUnsafe.mockResolvedValue([
          { id: 'p3', fen: 'fen', moves: 'e2e4', rating: 1200, themes: 'fork', source: 'lichess', game_url: null, opening_tags: null },
        ]);

        const result = await service.getNextPuzzle('user-1');

        expect(result.id).toBe('p3');
        expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
        const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
        expect(sql).toContain('NOT EXISTS');
        expect(sql).toContain('pa.solved = true');
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
});
