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
    sourceHeaders: { Event: 'Test' },
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
  };
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      tacticPuzzleAttempt,
      userTacticRating,
      tacticPuzzle,
    }),
  );
  return {
    tacticPuzzle,
    tacticPuzzleAttempt,
    userTacticRating,
    tacticUserMistake,
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
