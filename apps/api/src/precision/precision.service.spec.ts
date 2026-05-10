jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrecisionService } from './precision.service';

describe('PrecisionService (KS-2718 / ADR-056)', () => {
  let service: PrecisionService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      puzzleAttempt: {
        count: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      precisionAttempt: {
        aggregate: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new PrecisionService(prisma);
  });

  // ─── getStatsForUser ───────────────────────────────────────────────

  describe('getStatsForUser', () => {
    it('пользователь без PVE-attempts → нули и null', async () => {
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: null } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } });
      prisma.precisionAttempt.findMany.mockResolvedValue([]);

      const r = await service.getStatsForUser('user-1');

      expect(r).toEqual({
        totalAttempts: 0,
        preservedCount: 0,
        lostCount: 0,
        preservedRate: 0,
        avgAccuracyPercent: 0,
        avgWdlLeakPerMove: 0,
        avgHalfMovesUntilFirstMistake: null,
        todayAttempts: 0,
        todayPreserved: 0,
      });
    });

    it('считает агрегаты для PVE-attempts', async () => {
      // total=10, preserved=4, today=3, todayPreserved=1
      prisma.puzzleAttempt.count
        .mockResolvedValueOnce(10) // totalAttempts
        .mockResolvedValueOnce(4) //  preservedCount
        .mockResolvedValueOnce(3) //  todayAttempts
        .mockResolvedValueOnce(1); // todayPreserved
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: 78.5 } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: 4.2 } });
      // wdlLeakSum=0.5 за 5 ходов, 0.3 за 3 хода → totalLeak=0.8, totalMoves=8 → 0.1/move
      prisma.precisionAttempt.findMany.mockResolvedValue([
        { wdlLeakSum: 0.5, halfMovesPlayed: 5 },
        { wdlLeakSum: 0.3, halfMovesPlayed: 3 },
      ]);

      const r = await service.getStatsForUser('user-1');

      expect(r.totalAttempts).toBe(10);
      expect(r.preservedCount).toBe(4);
      expect(r.lostCount).toBe(6);
      expect(r.preservedRate).toBe(0.4);
      expect(r.avgAccuracyPercent).toBe(78.5);
      expect(r.avgWdlLeakPerMove).toBeCloseTo(0.1, 5);
      expect(r.avgHalfMovesUntilFirstMistake).toBe(4.2);
      expect(r.todayAttempts).toBe(3);
      expect(r.todayPreserved).toBe(1);
    });

    it('фильтр PVE через relation puzzle.solutionMode', async () => {
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: null } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } });
      prisma.precisionAttempt.findMany.mockResolvedValue([]);

      await service.getStatsForUser('user-1');

      const callArg = prisma.puzzleAttempt.count.mock.calls[0][0];
      expect(callArg.where).toMatchObject({
        userId: 'user-1',
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
      });
    });

    it('since-фильтр прокидывается в createdAt', async () => {
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: null } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } });
      prisma.precisionAttempt.findMany.mockResolvedValue([]);

      const since = new Date('2026-01-01');
      await service.getStatsForUser('user-1', since);

      const callArg = prisma.puzzleAttempt.count.mock.calls[0][0];
      expect(callArg.where).toMatchObject({
        userId: 'user-1',
        createdAt: { gte: since },
      });
    });
  });

  // ─── listAttemptsForUser (KS-2724) ─────────────────────────────────

  describe('listAttemptsForUser', () => {
    it('возвращает items + total для PVE-attempts', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([
        {
          id: 'attempt-1',
          puzzleId: 'p1',
          createdAt: new Date('2026-05-10T10:00:00Z'),
          solved: true,
          puzzle: { id: 'p1', fen: 'fen-1' },
          precisionAttempt: {
            attemptId: 'attempt-1',
            endReason: 'win',
            halfMovesPlayed: 6,
            accuracyPercent: 83.3,
            bestMovesCount: 4,
            goodMovesCount: 1,
            inaccuraciesCount: 1,
            mistakesCount: 0,
            blundersCount: 0,
          },
        },
        {
          id: 'attempt-2',
          puzzleId: 'p2',
          createdAt: new Date('2026-05-09T10:00:00Z'),
          solved: false,
          puzzle: { id: 'p2', fen: 'fen-2' },
          precisionAttempt: {
            attemptId: 'attempt-2',
            endReason: 'lose-wdl',
            halfMovesPlayed: 4,
            accuracyPercent: 25,
            bestMovesCount: 0,
            goodMovesCount: 1,
            inaccuraciesCount: 1,
            mistakesCount: 1,
            blundersCount: 1,
          },
        },
      ]);
      prisma.puzzleAttempt.count.mockResolvedValue(7);

      const r = await service.listAttemptsForUser('user-1', 20, 0);

      expect(r.total).toBe(7);
      expect(r.items).toHaveLength(2);
      expect(r.items[0]).toEqual({
        attemptId: 'attempt-1',
        puzzleId: 'p1',
        puzzleFen: 'fen-1',
        attemptedAt: '2026-05-10T10:00:00.000Z',
        solved: true,
        endReason: 'win',
        halfMovesPlayed: 6,
        accuracyPercent: 83.3,
        classCounts: {
          best: 4,
          good: 1,
          inaccuracy: 1,
          mistake: 0,
          blunder: 0,
        },
      });
      expect(r.items[1].endReason).toBe('lose-wdl');
      expect(r.items[1].classCounts.blunder).toBe(1);
    });

    it('фильтр PVE через relation + precisionAttempt is not null', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      await service.listAttemptsForUser('user-1', 20, 0);

      const findArg = prisma.puzzleAttempt.findMany.mock.calls[0][0];
      expect(findArg.where).toMatchObject({
        userId: 'user-1',
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
        precisionAttempt: { isNot: null },
      });
      expect(findArg.orderBy).toEqual({ createdAt: 'desc' });
      expect(findArg.take).toBe(20);
      expect(findArg.skip).toBe(0);
    });

    it('пустой список → items=[], total=0', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      const r = await service.listAttemptsForUser('user-1', 20, 0);
      expect(r).toEqual({ items: [], total: 0 });
    });

    it('limit + offset прокидываются в take/skip', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      await service.listAttemptsForUser('user-1', 5, 10);

      const findArg = prisma.puzzleAttempt.findMany.mock.calls[0][0];
      expect(findArg.take).toBe(5);
      expect(findArg.skip).toBe(10);
    });
  });

  // ─── getAttemptDetail ──────────────────────────────────────────────

  describe('getAttemptDetail', () => {
    const baseAttempt = {
      id: 'attempt-1',
      puzzleId: 'puzzle-1',
      userId: 'owner-1',
      solved: true,
      timeMs: 7000,
      createdAt: new Date('2026-05-10T10:00:00Z'),
      precisionAttempt: {
        attemptId: 'attempt-1',
        wdlAtStartSigned: 0.4,
        wdlAtEndSigned: 0.6,
        halfMovesPlayed: 6,
        halfMovesTarget: 6,
        accuracyPercent: 83.3,
        bestMovesCount: 4,
        goodMovesCount: 1,
        inaccuraciesCount: 1,
        mistakesCount: 0,
        blundersCount: 0,
        firstMistakePly: null,
        wdlLeakSum: 0.05,
        endReason: 'win',
        moves: [
          {
            ply: 1,
            fenBefore: 'fen-before-1',
            playedUci: 'e2e4',
            bestUci: 'e2e4',
            cpBefore: 30,
            cpAfter: 35,
            wdlBeforeW: 600,
            wdlBeforeD: 200,
            wdlBeforeL: 200,
            wdlAfterW: 620,
            wdlAfterD: 180,
            wdlAfterL: 200,
            depth: 14,
            classification: 'best',
          },
        ],
      },
      puzzle: { id: 'puzzle-1', solutionMode: 'play-vs-engine' },
    };

    it('возвращает все детали для владельца attempt', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue(baseAttempt);

      const r = await service.getAttemptDetail('attempt-1', 'owner-1', false);

      expect(r.attemptId).toBe('attempt-1');
      expect(r.puzzleId).toBe('puzzle-1');
      expect(r.solved).toBe(true);
      expect(r.endReason).toBe('win');
      expect(r.halfMovesPlayed).toBe(6);
      expect(r.accuracyPercent).toBe(83.3);
      expect(r.classCounts).toEqual({
        best: 4,
        good: 1,
        inaccuracy: 1,
        mistake: 0,
        blunder: 0,
      });
      expect(r.wdlAtStart).toBe(0.4);
      expect(r.wdlAtEnd).toBe(0.6);
      expect(r.firstMistakePly).toBeNull();
      expect(r.moves).toHaveLength(1);
      expect(r.moves[0].playedUci).toBe('e2e4');
      // signed WDL: (600-200)/1000 = 0.4
      expect(r.moves[0].wdlBefore).toBeCloseTo(0.4, 5);
      // (620-200)/1000 = 0.42
      expect(r.moves[0].wdlAfter).toBeCloseTo(0.42, 5);
      expect(r.moves[0].classification).toBe('best');
    });

    it('возвращает детали для админа (даже если не владелец)', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue(baseAttempt);

      const r = await service.getAttemptDetail(
        'attempt-1',
        'other-user',
        true,
      );
      expect(r.attemptId).toBe('attempt-1');
    });

    it('403 для не-владельца не-админа', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue(baseAttempt);

      await expect(
        service.getAttemptDetail('attempt-1', 'stranger', false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404 если attemptId не существует', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue(null);

      await expect(
        service.getAttemptDetail('missing', 'user-1', false),
      ).rejects.toThrow(NotFoundException);
    });

    it('404 если attempt существует, но это forced-line (без precision)', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue({
        ...baseAttempt,
        precisionAttempt: null,
        puzzle: { id: 'puzzle-1', solutionMode: 'forced-line' },
      });

      await expect(
        service.getAttemptDetail('attempt-1', 'owner-1', false),
      ).rejects.toThrow(NotFoundException);
    });

    it('404 если у PVE-attempt по какой-то причине нет precisionAttempt записи', async () => {
      prisma.puzzleAttempt.findUnique.mockResolvedValue({
        ...baseAttempt,
        precisionAttempt: null,
      });

      await expect(
        service.getAttemptDetail('attempt-1', 'owner-1', false),
      ).rejects.toThrow(NotFoundException);
    });

    it('null cp/wdl у move корректно проходят в response', async () => {
      const attemptWithNulls = {
        ...baseAttempt,
        precisionAttempt: {
          ...baseAttempt.precisionAttempt,
          moves: [
            {
              ply: 1,
              fenBefore: 'fen',
              playedUci: 'e2e4',
              bestUci: 'd2d4',
              cpBefore: null,
              cpAfter: null,
              wdlBeforeW: null,
              wdlBeforeD: null,
              wdlBeforeL: null,
              wdlAfterW: null,
              wdlAfterD: null,
              wdlAfterL: null,
              depth: null,
              classification: 'good',
            },
          ],
        },
      };
      prisma.puzzleAttempt.findUnique.mockResolvedValue(attemptWithNulls);

      const r = await service.getAttemptDetail('attempt-1', 'owner-1', false);

      expect(r.moves[0].cpBefore).toBeNull();
      expect(r.moves[0].cpAfter).toBeNull();
      expect(r.moves[0].wdlBefore).toBeNull();
      expect(r.moves[0].wdlAfter).toBeNull();
      expect(r.moves[0].depth).toBeNull();
    });
  });
});
