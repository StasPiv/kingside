/**
 * KS-4342 / ADR-135 §2.4. Юнит-тесты для TacticPuzzleService.
 * Покрытие: getNextForUser (исключение solved), submitAttempt (рейтинг
 * растёт на solve / падает на fail, mistake добавляется при mistake/
 * timeout, не добавляется при easy/aborted), listMistakes (пагинация
 * по cursor).
 */
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { GlickoRatingService } from '../puzzle/glicko-rating.service';
import {
  TacticPuzzleService,
  isSolvedStopReason,
} from './tactic-puzzle.service';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const PUZZLE_ID = '22222222-2222-4222-a222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-a333-333333333333';

function makePuzzleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PUZZLE_ID,
    fen: '8/p7/5P2/6k1/8/4n1K1/1P5r/8 w - - 0 49',
    bestMoveUci: 'e3c2',
    solverSide: 'w',
    bestE: 0.5,
    secondE: 0.0,
    gap: 0.5,
    difficulty: 0.98,
    wdlW: 1,
    wdlD: 997,
    wdlL: 2,
    objective: 'saveEquality',
    themes: 'endgame mate-threat',
    rating: 1600,
    ratingDev: 200,
    popularity: 0,
    nbPlays: 0,
    sourceGameId: null,
    sourceMoveNum: 48,
    sourceWhiteElo: 2384,
    sourceBlackElo: 2416,
    sourceHeaders: {
      Event: 'Test',
      White: 'Bogdanov, Egor',
      Black: 'Pivovartsev, Stanislav',
    },
    algorithmVersion: 'maia-difficulty-v1',
    maiaElo: 2400,
    sfMainNodes: 1_000_000,
    sfVerifyNodes: 10_000_000,
    sfMultiPv: 10,
    createdAt: new Date('2026-06-19T17:00:00Z'),
    ...overrides,
  };
}

function makePrismaMock(overrides: Record<string, unknown> = {}) {
  const tacticPuzzle = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  };
  const tacticPuzzleAttempt = {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
  };
  const userTacticRating = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  };
  const tacticUserMistake = {
    findMany: jest.fn(),
    upsert: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const tacticRatingSnapshot = {
    findMany: jest.fn().mockResolvedValue([]),
  };
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      tacticPuzzleAttempt,
      userTacticRating,
      tacticPuzzle,
      tacticUserMistake,
    }),
  );
  return {
    tacticPuzzle,
    tacticPuzzleAttempt,
    userTacticRating,
    tacticUserMistake,
    tacticRatingSnapshot,
    $transaction,
    ...overrides,
  };
}

describe('TacticPuzzleService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: TacticPuzzleService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new TacticPuzzleService(
      prisma as never,
      new GlickoRatingService(),
    );
  });

  describe('getNextForUser', () => {
    it('исключает уже решённые пазлы и возвращает из ближайших по рейтингу', async () => {
      prisma.tacticPuzzleAttempt.findMany.mockResolvedValueOnce([
        { puzzleId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      ]);
      prisma.tacticPuzzle.findMany.mockResolvedValueOnce([makePuzzleRow()]);
      prisma.userTacticRating.findUnique.mockResolvedValueOnce(null);

      const res = await service.getNextForUser(USER_ID);
      expect(res.id).toBe(PUZZLE_ID);
      const whereArg = prisma.tacticPuzzle.findMany.mock.calls[0][0].where;
      expect(whereArg.id).toEqual({
        notIn: ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'],
      });
    });

    it('падает 404 если банк пуст', async () => {
      prisma.tacticPuzzleAttempt.findMany.mockResolvedValueOnce([]);
      prisma.userTacticRating.findUnique.mockResolvedValueOnce(null);
      // Первый запрос (диапазон ±200) и fallback оба пустые.
      prisma.tacticPuzzle.findMany.mockResolvedValue([]);

      await expect(service.getNextForUser(USER_ID)).rejects.toThrow(
        /No tactic puzzles available/,
      );
    });
  });

  describe('submitAttempt', () => {
    beforeEach(() => {
      prisma.tacticPuzzle.findUnique.mockResolvedValue(makePuzzleRow());
      prisma.userTacticRating.findUnique.mockResolvedValue(null);
      prisma.tacticPuzzleAttempt.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: ATTEMPT_ID,
          ...data,
        }),
      );
      prisma.userTacticRating.upsert.mockResolvedValue(undefined);
      prisma.tacticPuzzle.update.mockResolvedValue(undefined);
      prisma.tacticUserMistake.upsert.mockResolvedValue(undefined);
    });

    it('solved → рейтинг пользователя растёт, mistake не пишется', async () => {
      const res = await service.submitAttempt(USER_ID, PUZZLE_ID, {
        lineHalfMoves: 4,
        userMoves: 'e3c2 a1b2 c2d4 b2a1',
        stopReason: 'easy',
        timeMs: 12000,
        wdlStart: 0.5,
        wdlEnd: 0.5,
        movesAccuracy: 1,
        precisionGrade: 5,
      });

      expect(res.solved).toBe(true);
      expect(res.ratingAfter).toBeGreaterThan(res.ratingBefore);
      expect(res.addedToMistakes).toBe(false);
      expect(prisma.tacticUserMistake.upsert).not.toHaveBeenCalled();
    });

    it('mistake → рейтинг падает, пазл добавлен в mistakes', async () => {
      const res = await service.submitAttempt(USER_ID, PUZZLE_ID, {
        lineHalfMoves: 1,
        userMoves: 'h2g2',
        stopReason: 'mistake',
        timeMs: 5000,
        wdlStart: 0.5,
        wdlEnd: 0.0,
      });

      expect(res.solved).toBe(false);
      expect(res.ratingAfter).toBeLessThan(res.ratingBefore);
      expect(res.addedToMistakes).toBe(true);
      expect(prisma.tacticUserMistake.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_puzzleId: { userId: USER_ID, puzzleId: PUZZLE_ID } },
        }),
      );
    });

    it('aborted → mistake НЕ пишется (пользователь сам прервал)', async () => {
      const res = await service.submitAttempt(USER_ID, PUZZLE_ID, {
        lineHalfMoves: 0,
        userMoves: '',
        stopReason: 'aborted',
        timeMs: 1000,
      });

      expect(res.solved).toBe(false);
      expect(res.addedToMistakes).toBe(false);
      expect(prisma.tacticUserMistake.upsert).not.toHaveBeenCalled();
    });

    it('puzzle.findUnique=null → 404', async () => {
      prisma.tacticPuzzle.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.submitAttempt(USER_ID, PUZZLE_ID, {
          lineHalfMoves: 0,
          userMoves: '',
          stopReason: 'mate',
          timeMs: 1000,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('submitAttempt / авто-резолв mistake', () => {
    beforeEach(() => {
      prisma.tacticPuzzle.findUnique.mockResolvedValue(makePuzzleRow());
      prisma.userTacticRating.findUnique.mockResolvedValue(null);
      prisma.tacticPuzzleAttempt.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: ATTEMPT_ID,
          ...data,
        }),
      );
      prisma.userTacticRating.upsert.mockResolvedValue(undefined);
      prisma.tacticPuzzle.update.mockResolvedValue(undefined);
    });

    it('solved=true → updateMany resolves существующий mistake', async () => {
      prisma.tacticUserMistake.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await service.submitAttempt(USER_ID, PUZZLE_ID, {
        lineHalfMoves: 4,
        userMoves: 'e3c2 a1b2 c2d4 b2a1',
        stopReason: 'easy',
        timeMs: 12000,
      });
      expect(res.solved).toBe(true);
      expect(prisma.tacticUserMistake.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, puzzleId: PUZZLE_ID, resolved: false },
        data: { resolved: true },
      });
      expect(prisma.tacticUserMistake.upsert).not.toHaveBeenCalled();
    });

    it('solved=true без записи в журнале → updateMany count=0, ошибки нет', async () => {
      prisma.tacticUserMistake.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.submitAttempt(USER_ID, PUZZLE_ID, {
          lineHalfMoves: 4,
          userMoves: 'e3c2',
          stopReason: 'easy',
          timeMs: 12000,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('resolveMistake', () => {
    it('updateMany.count > 0 → ОК', async () => {
      prisma.tacticUserMistake.updateMany.mockResolvedValueOnce({ count: 1 });
      await expect(
        service.resolveMistake(USER_ID, PUZZLE_ID),
      ).resolves.toBeUndefined();
    });
    it('updateMany.count = 0 → 404', async () => {
      prisma.tacticUserMistake.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.resolveMistake(USER_ID, PUZZLE_ID),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('listAttempts', () => {
    it('возвращает попытки текущего пользователя с фильтрами и cursor', async () => {
      const ATTEMPT_2 = '88888888-8888-4888-a888-888888888888';
      const attemptRows = [
        {
          id: ATTEMPT_ID,
          puzzleId: PUZZLE_ID,
          userId: USER_ID,
          solved: true,
          timeMs: 12000,
          ratingBefore: 1500,
          ratingAfter: 1515,
          puzzleRatingBefore: 1600,
          puzzleRatingAfter: 1585,
          lineHalfMoves: 4,
          userMoves: 'e3c2 a1b2',
          stopReason: 'easy',
          wdlStart: 0.5,
          wdlEnd: 0.5,
          movesAccuracy: 1,
          precisionGrade: 5,
          createdAt: new Date('2026-06-20T05:00:00Z'),
          puzzle: makePuzzleRow(),
        },
        {
          id: ATTEMPT_2,
          puzzleId: PUZZLE_ID,
          userId: USER_ID,
          solved: false,
          timeMs: 8000,
          ratingBefore: 1515,
          ratingAfter: 1500,
          puzzleRatingBefore: 1585,
          puzzleRatingAfter: 1600,
          lineHalfMoves: 1,
          userMoves: 'h2g2',
          stopReason: 'mistake',
          wdlStart: 0.5,
          wdlEnd: 0,
          movesAccuracy: null,
          precisionGrade: null,
          createdAt: new Date('2026-06-20T04:00:00Z'),
          puzzle: makePuzzleRow(),
        },
      ];
      // 2 элемента при take=1+1 — должен сработать hasMore.
      prisma.tacticPuzzleAttempt.findMany.mockResolvedValueOnce(attemptRows);
      const page = await service.listAttempts(USER_ID, { limit: 1 });
      expect(page.items.length).toBe(1);
      expect(page.items[0].id).toBe(ATTEMPT_ID);
      expect(page.items[0].ratingDelta).toBe(15);
      expect(page.items[0].playersTitle).toBe('Bogdanov, Egor vs Pivovartsev, Stanislav');
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe('getAttemptDetail', () => {
    it('возвращает детали попытки текущего пользователя', async () => {
      prisma.tacticPuzzleAttempt.findUnique.mockResolvedValueOnce({
        id: ATTEMPT_ID,
        puzzleId: PUZZLE_ID,
        userId: USER_ID,
        solved: true,
        timeMs: 12000,
        ratingBefore: 1500,
        ratingAfter: 1515,
        puzzleRatingBefore: 1600,
        puzzleRatingAfter: 1585,
        lineHalfMoves: 4,
        userMoves: 'e3c2 a1b2 c2d4 b2a1',
        stopReason: 'easy',
        wdlStart: 0.5,
        wdlEnd: 0.5,
        movesAccuracy: 1,
        precisionGrade: 5,
        createdAt: new Date('2026-06-20T05:00:00Z'),
        puzzle: makePuzzleRow(),
      });
      const detail = await service.getAttemptDetail(USER_ID, ATTEMPT_ID);
      expect(detail.userMoves).toBe('e3c2 a1b2 c2d4 b2a1');
      expect(detail.puzzle.fen).toBe(makePuzzleRow().fen);
      expect(detail.puzzle.themes).toEqual(['endgame', 'mate-threat']);
    });

    it('чужая попытка → 404', async () => {
      prisma.tacticPuzzleAttempt.findUnique.mockResolvedValueOnce({
        id: ATTEMPT_ID,
        userId: 'someone-else',
        puzzle: makePuzzleRow(),
      });
      await expect(
        service.getAttemptDetail(USER_ID, ATTEMPT_ID),
      ).rejects.toThrow(/not found/);
    });

    it('отсутствующая попытка → 404', async () => {
      prisma.tacticPuzzleAttempt.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getAttemptDetail(USER_ID, ATTEMPT_ID),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('getUserStats', () => {
    it('агрегаты, серия подряд, breakdown', async () => {
      prisma.userTacticRating.findUnique.mockResolvedValueOnce({
        userId: USER_ID,
        rating: 1620,
        deviation: 80,
        attempts: 12,
        lastAttemptAt: new Date('2026-06-20T05:00:00Z'),
      });
      const a = (overrides: Record<string, unknown>) => ({
        timeMs: 10000,
        lineHalfMoves: 3,
        precisionGrade: 4,
        puzzle: { objective: 'saveEquality', difficulty: 0.95 },
        ...overrides,
      });
      // последовательность: 3 solved, потом 1 unsolved (стрик
      // current=0, best=3), потом 2 solved (current=2).
      const attempts = [
        a({ solved: true, stopReason: 'easy' }),
        a({ solved: true, stopReason: 'mate' }),
        a({ solved: true, stopReason: 'easy' }),
        a({ solved: false, stopReason: 'mistake' }),
        a({ solved: true, stopReason: 'easy' }),
        a({ solved: true, stopReason: 'easy' }),
      ];
      prisma.tacticPuzzleAttempt.findMany.mockResolvedValueOnce(attempts);
      const stats = await service.getUserStats(USER_ID);
      expect(stats.rating.value).toBe(1620);
      expect(stats.totals.attempts).toBe(6);
      expect(stats.totals.solved).toBe(5);
      expect(stats.totals.solvedPercent).toBe(83);
      expect(stats.streak.current).toBe(2);
      expect(stats.streak.best).toBe(3);
      expect(stats.stopReasonBreakdown.easy).toBe(4);
      expect(stats.stopReasonBreakdown.mate).toBe(1);
      expect(stats.stopReasonBreakdown.mistake).toBe(1);
      expect(stats.objectiveBreakdown.saveEquality).toBe(6);
    });

    it('пустой набор → дефолты', async () => {
      prisma.userTacticRating.findUnique.mockResolvedValueOnce(null);
      prisma.tacticPuzzleAttempt.findMany.mockResolvedValueOnce([]);
      const stats = await service.getUserStats(USER_ID);
      expect(stats.totals.attempts).toBe(0);
      expect(stats.totals.solvedPercent).toBe(0);
      expect(stats.streak).toEqual({ current: 0, best: 0 });
      expect(stats.rating.value).toBe(1500);
      expect(stats.rating.lastAttemptAt).toBeNull();
    });
  });

  describe('getRatingHistory', () => {
    it('возвращает массив точек YYYY-MM-DD', async () => {
      prisma.tacticRatingSnapshot.findMany.mockResolvedValueOnce([
        {
          date: new Date('2026-06-18T00:00:00Z'),
          rating: 1500.6,
          attempts: 5,
          solved: 3,
        },
        {
          date: new Date('2026-06-19T00:00:00Z'),
          rating: 1520.4,
          attempts: 8,
          solved: 6,
        },
      ]);
      const pts = await service.getRatingHistory(USER_ID, {});
      expect(pts).toEqual([
        { date: '2026-06-18', rating: 1501, attempts: 5, solved: 3 },
        { date: '2026-06-19', rating: 1520, attempts: 8, solved: 6 },
      ]);
    });
  });

  describe('listMistakes', () => {
    it('возвращает unresolved-mistake пользователя с next-cursor', async () => {
      const mistakeRow = {
        id: '44444444-4444-4444-a444-444444444444',
        userId: USER_ID,
        puzzleId: PUZZLE_ID,
        createdAt: new Date('2026-06-19T18:00:00Z'),
        resolved: false,
        puzzle: makePuzzleRow(),
      };
      // Возвращаем 2 элемента при take=1+1 → должен сработать hasMore.
      prisma.tacticUserMistake.findMany.mockResolvedValueOnce([
        mistakeRow,
        { ...mistakeRow, id: '55555555-5555-4555-a555-555555555555' },
      ]);
      const page = await service.listMistakes(USER_ID, undefined, 1);
      expect(page.items.length).toBe(1);
      expect(page.items[0].puzzleId).toBe(PUZZLE_ID);
      expect(page.nextCursor).not.toBeNull();
    });
  });
});

describe('isSolvedStopReason', () => {
  it('easy / mate → solved', () => {
    expect(isSolvedStopReason('easy')).toBe(true);
    expect(isSolvedStopReason('mate')).toBe(true);
  });
  it('mistake / timeout / aborted → not solved', () => {
    expect(isSolvedStopReason('mistake')).toBe(false);
    expect(isSolvedStopReason('timeout')).toBe(false);
    expect(isSolvedStopReason('aborted')).toBe(false);
  });
});
