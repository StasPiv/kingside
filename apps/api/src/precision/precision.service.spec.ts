jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { classifyPhaseByFen, PrecisionService } from './precision.service';

describe('PrecisionService (KS-2718 / ADR-056)', () => {
  let service: PrecisionService;
  let prisma: any;
  let redis: any;

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
        // KS-3000: groupBy для scoreDistribution; дефолт — пусто
        // (нет attempts со score!=null).
        groupBy: jest.fn().mockResolvedValue([]),
      },
      // KS-3345: для getScopeCounts.
      puzzle: {
        count: jest.fn(),
      },
      // KS-3346: для getMyRating.
      userPrecisionRating: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      // KS-3344: для pickNext.
      $queryRawUnsafe: jest.fn(),
    };
    // KS-3344: добавим findMany для pickNext (через mutation после init).
    prisma.puzzle.findMany = jest.fn().mockResolvedValue([]);
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    service = new PrecisionService(prisma, redis);
  });

  // ─── getStatsForUser ───────────────────────────────────────────────

  describe('getStatsForUser', () => {
    it('пользователь без PVE-attempts → нули и null', async () => {
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: null } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } })
        // KS-3000: 3-й aggregate — score/scorePct (null когда нет attempts).
        .mockResolvedValueOnce({ _avg: { score: null, scorePct: null } });
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
        // KS-3000: пустой набор → null/нули.
        avgScore: null,
        avgScorePct: null,
        scoreDistribution: {
          stars1: 0,
          stars2: 0,
          stars3: 0,
          stars4: 0,
          stars5: 0,
        },
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
        .mockResolvedValueOnce({ _avg: { firstMistakePly: 4.2 } })
        // KS-3000: avgScore=3.4, avgScorePct=77.1.
        .mockResolvedValueOnce({ _avg: { score: 3.4, scorePct: 77.1 } });
      // KS-3000: распределение по звёздам.
      prisma.precisionAttempt.groupBy.mockResolvedValue([
        { score: 1, _count: { score: 1 } },
        { score: 2, _count: { score: 2 } },
        { score: 3, _count: { score: 3 } },
        { score: 4, _count: { score: 2 } },
        { score: 5, _count: { score: 1 } },
      ]);
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
      // KS-3000 / ADR-065 §6.5.
      expect(r.avgScore).toBe(3.4);
      expect(r.avgScorePct).toBe(77.1);
      expect(r.scoreDistribution).toEqual({
        stars1: 1,
        stars2: 2,
        stars3: 3,
        stars4: 2,
        stars5: 1,
      });
    });

    it('фильтр PVE через relation puzzle.solutionMode', async () => {
      prisma.puzzleAttempt.count.mockResolvedValue(0);
      prisma.precisionAttempt.aggregate
        .mockResolvedValueOnce({ _avg: { accuracyPercent: null } })
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } })
        // KS-3000: 3-й aggregate — score/scorePct (null когда нет attempts).
        .mockResolvedValueOnce({ _avg: { score: null, scorePct: null } });
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
        .mockResolvedValueOnce({ _avg: { firstMistakePly: null } })
        // KS-3000: 3-й aggregate — score/scorePct (null когда нет attempts).
        .mockResolvedValueOnce({ _avg: { score: null, scorePct: null } });
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
            // KS-3000.
            score: 4,
            scorePct: 87.5,
            // KS-3341: precision-рейтинг записан (нормальный кейс).
            ratingBefore: 1487.4,
            ratingAfter: 1499.2,
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
            // KS-3000: legacy без score (halfMoves<2 или нет данных).
            score: null,
            scorePct: null,
            // KS-3341 / anti-cheat: попытка по self-created пазлу →
            // рейтинг не считался.
            ratingBefore: null,
            ratingAfter: null,
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
        // KS-3000: 5★-оценка пробрасывается из БД.
        score: 4,
        // KS-3077: scorePct из той же WDL/cp-шкалы — фронт показывает
        // его на карточке вместо accuracyPercent.
        scorePct: 87.5,
        // KS-3246: objectiveAchieved в этом mock'е не задан → undefined
        // (legacy без поля). verdictKey вычисляется computeVerdictKey
        // (null → fallback ветка goal_achieved=true): 4★+null → 'confident'.
        objectiveAchieved: undefined,
        verdictKey: 'confident',
        // KS-3341 / ADR-082 §7 F1. Rating-поля для UI-колонки ±delta.
        // Float из БД округлён до int. Delta = after - before.
        ratingBefore: 1487, // Math.round(1487.4)
        ratingAfter: 1499, // Math.round(1499.2)
        ratingDelta: 12, // 1499 - 1487
      });
      expect(r.items[1].endReason).toBe('lose-wdl');
      expect(r.items[1].classCounts.blunder).toBe(1);
      // KS-3000: legacy без данных → score=null.
      expect(r.items[1].score).toBeNull();
      // KS-3077: scorePct тоже null когда score=null.
      expect(r.items[1].scorePct).toBeNull();
      // KS-3341: self-created → рейтинг null синхронно.
      expect(r.items[1].ratingBefore).toBeNull();
      expect(r.items[1].ratingAfter).toBeNull();
      expect(r.items[1].ratingDelta).toBeNull();
    });

    it('фильтр PVE через relation puzzle.solutionMode (KS-2737: без precisionAttempt:isNot:null)', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([]);
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      await service.listAttemptsForUser('user-1', 20, 0);

      const findArg = prisma.puzzleAttempt.findMany.mock.calls[0][0];
      expect(findArg.where).toMatchObject({
        userId: 'user-1',
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
      });
      // KS-2737: фильтр precisionAttempt НЕ применяется — legacy attempts
      // (без moves[]-snapshot) тоже должны попадать в список.
      expect(findArg.where).not.toHaveProperty('precisionAttempt');
      expect(findArg.orderBy).toEqual({ createdAt: 'desc' });
      expect(findArg.take).toBe(20);
      expect(findArg.skip).toBe(0);
    });

    it('KS-2737: attempt без precisionAttempt → дефолтные агрегаты', async () => {
      prisma.puzzleAttempt.findMany.mockResolvedValue([
        {
          id: 'legacy-1',
          puzzleId: 'p-legacy',
          createdAt: new Date('2026-05-10T08:00:00Z'),
          solved: true,
          puzzle: { id: 'p-legacy', fen: 'fen-legacy' },
          precisionAttempt: null, // legacy без snapshot
        },
        {
          id: 'modern-1',
          puzzleId: 'p-modern',
          createdAt: new Date('2026-05-10T09:00:00Z'),
          solved: false,
          puzzle: { id: 'p-modern', fen: 'fen-modern' },
          precisionAttempt: {
            attemptId: 'modern-1',
            endReason: 'lose-wdl',
            halfMovesPlayed: 4,
            accuracyPercent: 50,
            bestMovesCount: 1,
            goodMovesCount: 1,
            inaccuraciesCount: 1,
            mistakesCount: 1,
            blundersCount: 0,
          },
        },
      ]);
      prisma.puzzleAttempt.count.mockResolvedValue(2);

      const r = await service.listAttemptsForUser('user-1', 20, 0);

      expect(r.total).toBe(2);
      expect(r.items).toHaveLength(2);
      // legacy attempt → дефолты
      expect(r.items[0]).toMatchObject({
        attemptId: 'legacy-1',
        endReason: 'legacy',
        halfMovesPlayed: 0,
        accuracyPercent: 0,
        classCounts: {
          best: 0,
          good: 0,
          inaccuracy: 0,
          mistake: 0,
          blunder: 0,
        },
        // KS-3077: legacy без precision_attempts → scorePct=null.
        scorePct: null,
        // KS-3341: legacy без precision_attempts → rating-поля null.
        ratingBefore: null,
        ratingAfter: null,
        ratingDelta: null,
      });
      // modern → реальные значения
      expect(r.items[1]).toMatchObject({
        attemptId: 'modern-1',
        endReason: 'lose-wdl',
        halfMovesPlayed: 4,
        accuracyPercent: 50,
      });
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
        // KS-3000.
        score: 4,
        scorePct: 87.2,
        moves: [
          {
            ply: 1,
            fenBefore: 'fen-before-1',
            playedUci: 'e2e4',
            bestUci: 'e2e4',
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
      // KS-2754: WDL отдаётся как {w,d,l} per-mille, не скаляр.
      expect(r.moves[0].wdlBefore).toEqual({ w: 600, d: 200, l: 200 });
      expect(r.moves[0].wdlAfter).toEqual({ w: 620, d: 180, l: 200 });
      expect(r.moves[0].classification).toBe('best');
      // KS-3000 / ADR-065 §6.1.
      expect(r.score).toBe(4);
      expect(r.scorePct).toBe(87.2);
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

    it('KS-2754: engineUci из БД пробрасывается в response', async () => {
      const attemptWithEngine = {
        ...baseAttempt,
        precisionAttempt: {
          ...baseAttempt.precisionAttempt,
          moves: [
            {
              ply: 1,
              fenBefore: 'fen-before-1',
              playedUci: 'e2e4',
              bestUci: 'e2e4',
              engineUci: 'e7e5',
              wdlBeforeW: 500,
              wdlBeforeD: 400,
              wdlBeforeL: 100,
              wdlAfterW: 500,
              wdlAfterD: 400,
              wdlAfterL: 100,
              depth: 14,
              classification: 'best',
            },
            {
              ply: 2,
              fenBefore: 'fen-before-2',
              playedUci: 'g1f3',
              bestUci: 'g1f3',
              engineUci: null,
              wdlBeforeW: 500,
              wdlBeforeD: 400,
              wdlBeforeL: 100,
              wdlAfterW: 500,
              wdlAfterD: 400,
              wdlAfterL: 100,
              depth: 14,
              classification: 'best',
            },
          ],
        },
      };
      prisma.puzzleAttempt.findUnique.mockResolvedValue(attemptWithEngine);

      const r = await service.getAttemptDetail('attempt-1', 'owner-1', false);

      expect(r.moves).toHaveLength(2);
      expect(r.moves[0].engineUci).toBe('e7e5');
      expect(r.moves[1].engineUci).toBeNull();
    });

    it('null wdl у move корректно проходят в response', async () => {
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

      expect(r.moves[0].wdlBefore).toBeNull();
      expect(r.moves[0].wdlAfter).toBeNull();
      expect(r.moves[0].depth).toBeNull();
    });
  });

  // ─── KS-3029: dev-only test fixture ────────────────────────────────

  describe('createTestFixtureAttempt (KS-3029)', () => {
    function setupTxMocks() {
      const txState: { attempt?: any; precision?: any; moves?: any[] } = {};
      prisma.puzzle = {
        findFirst: jest.fn().mockResolvedValue({ id: 'pve-puzzle-1' }),
      };
      prisma.$transaction = jest.fn(
        async (cb: (tx: any) => Promise<unknown>) => {
          const tx = {
            puzzleAttempt: {
              create: jest.fn(async ({ data }: any) => {
                txState.attempt = { id: 'fixture-attempt-1', ...data };
                return { id: 'fixture-attempt-1' };
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
          return cb(tx);
        },
      );
      return txState;
    }

    it('5★ кейс: 6 best (WDL не меняется) → score=5', async () => {
      const tx = setupTxMocks();
      const moves = new Array(6).fill(null).map((_, i) => ({
        ply: i + 1,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 1000, d: 0, l: 0 },
      }));

      const r = await service.createTestFixtureAttempt({
        userId: 'user-1',
        body: { moves },
      });

      expect(r.attemptId).toBe('fixture-attempt-1');
      expect(r.score).toBe(5);
      expect(r.scorePct).toBeCloseTo(100, 1);
      expect(tx.precision.bestMovesCount).toBe(6);
      expect(tx.moves).toHaveLength(6);
    });

    it('KS-3774: 5 best + 1 blunder с финальным WDL-loss=50% → score=1, scorePct ≈ 8.5', async () => {
      // KS-3774 пересмотр методики: точность считается ТОЛЬКО по
      // дельте WDL стартовой/конечной позиции, NAG к ходам и
      // worst-class cap не применяются. startE=1.0, endE=0.5,
      // loss_E=0.5 → scorePct ≈ 8.5 → 1★. (Старая методика давала
      // 2★ через cap=60 на worst-classification=blunder.)
      const tx = setupTxMocks();
      const bestMoves = ['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b1c3'].map(
        (uci, i) => ({
          ply: i + 1,
          playedUci: uci,
          bestUci: uci,
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 1000, d: 0, l: 0 },
        }),
      );
      const moves = [
        ...bestMoves,
        {
          ply: 6,
          playedUci: 'g2g4',
          bestUci: 'e2e4',
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 500, d: 0, l: 500 },
        },
      ];

      const r = await service.createTestFixtureAttempt({
        userId: 'user-1',
        body: { moves },
      });

      expect(r.score).toBe(1);
      expect(r.scorePct).not.toBeNull();
      expect(r.scorePct!).toBeGreaterThan(5);
      expect(r.scorePct!).toBeLessThan(15);
      // Счётчики classification (blundersCount/firstMistakePly) считаются
      // отдельным `classifyMove` и в KS-3774 не верифицируются — точность
      // по новой методике не зависит от классификации ходов.
    });

    it('puzzleId не указан → берёт первый PVE-пазл из БД', async () => {
      setupTxMocks();
      await service.createTestFixtureAttempt({
        userId: 'user-1',
        body: { moves: [{ ply: 1, playedUci: 'e2e4', bestUci: 'e2e4' }, { ply: 2, playedUci: 'd2d4', bestUci: 'd2d4' }] },
      });
      expect(prisma.puzzle.findFirst).toHaveBeenCalledWith({
        where: { solutionMode: 'play-vs-engine' },
        select: { id: true },
      });
    });

    it('puzzleId передан явно → не дёргает puzzle.findFirst', async () => {
      setupTxMocks();
      await service.createTestFixtureAttempt({
        userId: 'user-1',
        body: {
          puzzleId: 'custom-pve-id',
          moves: [{ ply: 1, playedUci: 'e2e4', bestUci: 'e2e4' }, { ply: 2, playedUci: 'd2d4', bestUci: 'd2d4' }],
        },
      });
      expect(prisma.puzzle.findFirst).not.toHaveBeenCalled();
    });

    it('пустой moves[] → 400 BadRequestException', async () => {
      setupTxMocks();
      await expect(
        service.createTestFixtureAttempt({
          userId: 'user-1',
          body: { moves: [] },
        }),
      ).rejects.toThrow('moves[] must be non-empty');
    });

    it('PVE-пазлов в БД нет, puzzleId не передан → 400', async () => {
      setupTxMocks();
      prisma.puzzle.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.createTestFixtureAttempt({
          userId: 'user-1',
          body: { moves: [{ ply: 1, playedUci: 'e2e4', bestUci: 'e2e4' }, { ply: 2, playedUci: 'd2d4', bestUci: 'd2d4' }] },
        }),
      ).rejects.toThrow('No PVE puzzle');
    });
  });

  // ─── KS-2727: trends + breakdowns ──────────────────────────────────

  describe('classifyPhaseByFen (KS-2727)', () => {
    it('стартовая позиция → opening (32 фигуры)', () => {
      expect(
        classifyPhaseByFen(
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        ),
      ).toBe('opening');
    });

    it('середина игры (~20 фигур) → middlegame', () => {
      // Простая позиция с урезанным составом.
      expect(
        classifyPhaseByFen('r3k2r/pp3ppp/8/8/8/8/PP3PPP/R3K2R w KQkq - 0 1'),
      ).toBe('middlegame');
    });

    it('эндшпиль (≤13 фигур, например ладейный) → endgame', () => {
      expect(classifyPhaseByFen('4k3/4p3/8/8/8/8/4P3/4K3 w - - 0 1')).toBe(
        'endgame',
      );
    });

    it('пустой/невалидный FEN → null', () => {
      expect(classifyPhaseByFen('')).toBeNull();
    });
  });

  describe('getTrendsForUser (KS-2727 B7.1)', () => {
    it('возвращает points с агрегатами и считает avgWdlLeakPerMove из sum/sum', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-05-04T00:00:00Z'), // понедельник
          attempts: BigInt(5),
          preserved: BigInt(3),
          avg_accuracy: 75.5,
          sum_leak: 0.4,
          sum_half_moves: BigInt(20),
          // KS-3000.
          avg_score: 3.2,
          avg_score_pct: 76.4,
          // KS-3376.
          rating_delta: 42.7,
          rating_end: 1532.4,
        },
        {
          bucket_start: new Date('2026-05-11T00:00:00Z'),
          attempts: BigInt(2),
          preserved: BigInt(2),
          avg_accuracy: 92.0,
          sum_leak: 0.0,
          sum_half_moves: BigInt(8),
          // KS-3000: бакет без score (legacy / old SQL).
          avg_score: null,
          avg_score_pct: null,
          // KS-3376: бакет без рейтинга (например, только гостевые
          // attempts были; их в реале в этом запросе не будет, но
          // фоллбек проверяем).
          rating_delta: null,
          rating_end: null,
        },
      ]);

      const r = await service.getTrendsForUser('user-1', { bucket: 'week' });

      expect(r.bucket).toBe('week');
      expect(r.points).toHaveLength(2);
      expect(r.points[0]).toEqual({
        bucketStart: '2026-05-04T00:00:00.000Z',
        attempts: 5,
        preserved: 3,
        avgAccuracyPercent: 75.5,
        avgWdlLeakPerMove: 0.02, // 0.4 / 20
        // KS-3000.
        avgScore: 3.2,
        avgScorePct: 76.4,
        // KS-3376: float из БД округляется до int для UI.
        ratingDelta: 43, // Math.round(42.7)
        ratingEnd: 1532, // Math.round(1532.4)
      });
      expect(r.points[1].avgWdlLeakPerMove).toBe(0); // 0 leak / 8 = 0
      expect(r.points[1].avgScore).toBeNull();
      expect(r.points[1].avgScorePct).toBeNull();
      // KS-3376: null синхронно (нет рейтинговых попыток в бакете).
      expect(r.points[1].ratingDelta).toBeNull();
      expect(r.points[1].ratingEnd).toBeNull();
    });

    it('KS-3376: ratingDelta может быть отрицательным (бакет с поражениями)', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-05-04T00:00:00Z'),
          attempts: BigInt(3),
          preserved: BigInt(0),
          avg_accuracy: 40.0,
          sum_leak: 0.6,
          sum_half_moves: BigInt(15),
          avg_score: 1.5,
          avg_score_pct: 35.0,
          rating_delta: -78.3,
          rating_end: 1421.9,
        },
      ]);
      const r = await service.getTrendsForUser('user-1', { bucket: 'week' });
      expect(r.points[0].ratingDelta).toBe(-78); // Math.round(-78.3)
      expect(r.points[0].ratingEnd).toBe(1422);
    });

    it('пустые данные → points=[]', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      const r = await service.getTrendsForUser('user-1', { bucket: 'day' });
      expect(r).toEqual({ bucket: 'day', points: [] });
    });

    it('bucket прокидывается в SQL date_trunc параметром', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      await service.getTrendsForUser('user-1', { bucket: 'month' });

      const args = prisma.$queryRawUnsafe.mock.calls[0];
      // args[0] — SQL, args[1] — userId, args[2] — bucket
      expect(args[1]).toBe('user-1');
      expect(args[2]).toBe('month');
    });
  });

  describe('getBreakdownsForUser (KS-2727 B7.2)', () => {
    it('считает byPhase по числу фигур в FEN первого хода', async () => {
      // Первый запрос — phase rows.
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([
          // 32 фигуры — opening
          {
            accuracy: 90,
            first_fen:
              'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          },
          // 20 фигур — middlegame
          {
            accuracy: 70,
            first_fen: 'r3k2r/pp3ppp/8/8/8/8/PP3PPP/R3K2R w KQkq - 0 1',
          },
          // 6 фигур — endgame
          {
            accuracy: 50,
            first_fen: '4k3/4p3/8/8/8/8/4P3/4K3 w - - 0 1',
          },
        ])
        // theme rows (empty)
        .mockResolvedValueOnce([]);

      const r = await service.getBreakdownsForUser('user-1');

      expect(r.byPhase).toEqual([
        { phase: 'opening', attempts: 1, avgAccuracyPercent: 90 },
        { phase: 'middlegame', attempts: 1, avgAccuracyPercent: 70 },
        { phase: 'endgame', attempts: 1, avgAccuracyPercent: 50 },
      ]);
    });

    it('byTheme — корректные счётчики и weakness=100-accuracy', async () => {
      prisma.$queryRawUnsafe
        // empty phase rows
        .mockResolvedValueOnce([])
        // theme rows
        .mockResolvedValueOnce([
          { theme: 'pin', attempts: BigInt(8), avg_accuracy: 60 },
          { theme: 'fork', attempts: BigInt(4), avg_accuracy: 80 },
          { theme: 'mate', attempts: BigInt(2), avg_accuracy: 95 },
        ]);

      const r = await service.getBreakdownsForUser('user-1');

      expect(r.byTheme).toEqual([
        { theme: 'pin', attempts: 8, avgAccuracyPercent: 60, weakness: 40 },
        { theme: 'fork', attempts: 4, avgAccuracyPercent: 80, weakness: 20 },
        { theme: 'mate', attempts: 2, avgAccuracyPercent: 95, weakness: 5 },
      ]);
    });

    it('пустые данные → byPhase нулевыми, byTheme=[]', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const r = await service.getBreakdownsForUser('user-1');
      expect(r.byPhase).toEqual([
        { phase: 'opening', attempts: 0, avgAccuracyPercent: 0 },
        { phase: 'middlegame', attempts: 0, avgAccuracyPercent: 0 },
        { phase: 'endgame', attempts: 0, avgAccuracyPercent: 0 },
      ]);
      expect(r.byTheme).toEqual([]);
    });
  });

  // ─── KS-3345 / ADR-079 §3.3: getScopeCounts ────────────────────

  describe('getScopeCounts', () => {
    it('гость → только server, drafts/published = 0', async () => {
      prisma.puzzle.count.mockResolvedValueOnce(1234);
      const r = await service.getScopeCounts(null);
      expect(r).toEqual({ server: 1234, drafts: 0, published: 0 });
      // Только один count.
      expect(prisma.puzzle.count).toHaveBeenCalledTimes(1);
      expect(prisma.puzzle.count).toHaveBeenCalledWith({
        where: { source: 'generated', isPublic: true },
      });
      // Гостю кеш не пишем.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('user → 3 count + 3 фильтра + redis set', async () => {
      prisma.puzzle.count
        .mockResolvedValueOnce(500) // server
        .mockResolvedValueOnce(12) // drafts
        .mockResolvedValueOnce(4); // published
      const r = await service.getScopeCounts('u-1');
      expect(r).toEqual({ server: 500, drafts: 12, published: 4 });
      // server: source='generated', is_public=true,
      // (created_by IS NULL OR created_by != userId)
      // KS-3352 follow-up: explicit OR с null branch для SQL NULL semantics.
      expect(prisma.puzzle.count).toHaveBeenNthCalledWith(1, {
        where: {
          source: 'generated',
          isPublic: true,
          OR: [
            { createdBy: null },
            { createdBy: { not: 'u-1' } },
          ],
        },
      });
      // drafts: source='generated', is_public=false, created_by = userId
      expect(prisma.puzzle.count).toHaveBeenNthCalledWith(2, {
        where: {
          source: 'generated',
          isPublic: false,
          createdBy: 'u-1',
        },
      });
      // published: source='generated', is_public=true, created_by = userId
      expect(prisma.puzzle.count).toHaveBeenNthCalledWith(3, {
        where: {
          source: 'generated',
          isPublic: true,
          createdBy: 'u-1',
        },
      });
      expect(redis.set).toHaveBeenCalledWith(
        'precision:scope-counts:u-1',
        JSON.stringify({ server: 500, drafts: 12, published: 4 }),
        'EX',
        60,
      );
    });

    it('user → cache hit, без обращения к БД', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ server: 100, drafts: 5, published: 2 }),
      );
      const r = await service.getScopeCounts('u-1');
      expect(r).toEqual({ server: 100, drafts: 5, published: 2 });
      expect(prisma.puzzle.count).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('user → redis get падает → fallback на БД', async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      prisma.puzzle.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      const r = await service.getScopeCounts('u-1');
      expect(r).toEqual({ server: 10, drafts: 2, published: 1 });
      expect(prisma.puzzle.count).toHaveBeenCalledTimes(3);
    });

    it('user → cache содержит мусор → fallback на БД', async () => {
      redis.get.mockResolvedValueOnce('not json');
      prisma.puzzle.count
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      const r = await service.getScopeCounts('u-1');
      expect(r).toEqual({ server: 7, drafts: 0, published: 0 });
    });
  });

  // ─── KS-3346 / ADR-079 §3.5: getMyRating ─────────────────────

  describe('getMyRating', () => {
    it('новый user без записи → default 1500/350/0/null', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce(null);
      const r = await service.getMyRating('u-1');
      expect(r).toEqual({
        rating: 1500,
        deviation: 350,
        attempts: 0,
        lastAttemptAt: null,
      });
    });

    it('существующий рейтинг → возвращается из БД', async () => {
      const at = new Date('2026-05-25T10:00:00Z');
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1700.5,
        deviation: 120,
        attempts: 42,
        lastAttemptAt: at,
      });
      const r = await service.getMyRating('u-1');
      expect(r).toEqual({
        rating: 1700.5,
        deviation: 120,
        attempts: 42,
        lastAttemptAt: '2026-05-25T10:00:00.000Z',
      });
    });

    it('существующий, lastAttemptAt=null → возвращается как null', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
        deviation: 350,
        attempts: 0,
        lastAttemptAt: null,
      });
      const r = await service.getMyRating('u-1');
      expect(r.lastAttemptAt).toBeNull();
    });
  });

  // ─── KS-3358 / ADR-080 §4.3: getThemeCounts ──────────────────

  describe('getThemeCounts', () => {
    beforeEach(() => {
      prisma.$queryRawUnsafe = jest.fn().mockResolvedValue([]);
    });

    it('гость → scope принудительно server, без hideSolved-attempts', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { theme: 'pin', cnt: 100 },
        { theme: 'fork', cnt: 50 },
      ]);
      const r = await service.getThemeCounts(null, {
        scope: 'drafts',
        hideSolved: true,
      });
      expect(r.counts).toEqual({ pin: 100, fork: 50 });
      const sql = prisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain(`solution_mode = 'play-vs-engine'`);
      // server (даже при scope=drafts для guest): is_public=true,
      // без created_by-фильтра.
      expect(sql).toContain('is_public = true');
      expect(sql).not.toContain('created_by IS NULL');
      // hideSolved для guest НЕ применяется (нет userId).
      expect(sql).not.toContain('NOT EXISTS');
    });

    it('user + scope=server + hideSolved → NULL-aware createdBy + NOT EXISTS attempts', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { theme: 'pin', cnt: 30 },
      ]);
      await service.getThemeCounts('u-1', {
        scope: 'server',
        hideSolved: true,
      });
      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('is_public = true');
      expect(sql).toContain(
        'created_by IS NULL OR created_by != $',
      );
      expect(sql).toContain('NOT EXISTS');
      // Whitelist передан последним параметром.
      const whitelist = params[params.length - 1];
      expect(Array.isArray(whitelist)).toBe(true);
      expect((whitelist as string[]).includes('pin')).toBe(true);
    });

    it('drafts: is_public=false, created_by=userId', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await service.getThemeCounts('u-1', {
        scope: 'drafts',
        hideSolved: false,
      });
      const sql = prisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('is_public = false');
      expect(sql).toContain('created_by = $');
      expect(sql).not.toContain('NOT EXISTS');
    });

    it('objective=convertAdvantage → themes LIKE %objective%', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await service.getThemeCounts('u-1', {
        scope: 'server',
        objective: 'convertAdvantage',
        hideSolved: false,
      });
      const [, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain('%convertAdvantage%');
    });

    it('ratingMin/Max → добавляются в WHERE', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await service.getThemeCounts('u-1', {
        scope: 'server',
        hideSolved: false,
        ratingMin: 1200,
        ratingMax: 1800,
      });
      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('rating >= $');
      expect(sql).toContain('rating <= $');
      expect(params).toContain(1200);
      expect(params).toContain(1800);
    });

    it('cache hit → пропускает SQL', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ counts: { pin: 99 } }),
      );
      const r = await service.getThemeCounts('u-1', { scope: 'server' });
      expect(r.counts).toEqual({ pin: 99 });
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('cache содержит мусор → fallback на SQL', async () => {
      redis.get.mockResolvedValueOnce('garbage');
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { theme: 'pin', cnt: 1 },
      ]);
      const r = await service.getThemeCounts('u-1', { scope: 'server' });
      expect(r.counts).toEqual({ pin: 1 });
    });

    it('cache set после SQL', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { theme: 'fork', cnt: 5 },
      ]);
      await service.getThemeCounts('u-1', { scope: 'server' });
      expect(redis.set).toHaveBeenCalled();
      const [key, value, ttlFlag, ttl] = redis.set.mock.calls[0];
      expect(key).toContain('precision:theme-counts:u-1');
      expect(typeof value).toBe('string');
      expect(ttlFlag).toBe('EX');
      expect(ttl).toBe(60);
    });
  });

  // ─── KS-3344 / ADR-079 §3.4: pickNext ────────────────────────

  describe('pickNext', () => {
    it('гость → target=1200, scope принудительно server', async () => {
      prisma.puzzle.findMany.mockResolvedValue([
        { id: 'p-1', rating: 1250 },
      ]);
      const r = await service.pickNext(null, { scope: 'drafts' });
      // KS-3663: результат теперь содержит maia-поля (null, т.к. в mock'е
      // их нет). Прежний `toEqual` без них — обновлён через toMatchObject.
      expect(r).toMatchObject({ puzzleId: 'p-1', rating: 1250, ratingDelta: 50 });
      // userPrecisionRating НЕ запрашивается для гостя.
      expect(prisma.userPrecisionRating.findUnique).not.toHaveBeenCalled();
      // findMany вызывался с isPublic=true (server scope).
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.source).toBe('generated');
      expect(call.where.isPublic).toBe(true);
      // Для гостя нет createdBy/NOT-фильтра.
      expect(call.where.createdBy).toBeUndefined();
      expect(call.where.NOT).toBeUndefined();
    });

    it('user с рейтингом 1800 → target=1800, окно 150', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1800,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-2', rating: 1750 },
      ]);
      const r = await service.pickNext('u-1', { scope: 'server' });
      // KS-3663: см. выше — toMatchObject вместо toEqual.
      expect(r).toMatchObject({ puzzleId: 'p-2', rating: 1750, ratingDelta: -50 });
      // Первое окно: 1650..1950.
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.rating).toEqual({ gte: 1650, lte: 1950 });
      // KS-3352 follow-up: server + user →
      // OR: [{ createdBy: null }, { createdBy: { not: userId } }]
      // (нужно для legacy puzzle с createdBy=NULL; на проде их 1530).
      expect(call.where.OR).toEqual([
        { createdBy: null },
        { createdBy: { not: 'u-1' } },
      ]);
      expect(call.where.NOT).toBeUndefined();
    });

    it('пустое окно 150 → расширяется до 300/500/..., picks с первого непустого', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany
        .mockResolvedValueOnce([]) // 150
        .mockResolvedValueOnce([]) // 300
        .mockResolvedValueOnce([{ id: 'p-3', rating: 1900 }]); // 500
      const r = await service.pickNext('u-1', { scope: 'server' });
      expect(r?.puzzleId).toBe('p-3');
      expect(prisma.puzzle.findMany).toHaveBeenCalledTimes(3);
      const widths = prisma.puzzle.findMany.mock.calls.map(
        (c: any) => c[0].where.rating.gte,
      );
      expect(widths).toEqual([1500 - 150, 1500 - 300, 1500 - 500]);
    });

    it('всё пусто (даже бесконечное окно) → null', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValue([]);
      const r = await service.pickNext('u-1', { scope: 'server' });
      expect(r).toBeNull();
      // 5 окон: 150/300/500/1000/∞ (последнее = 0..4000)
      expect(prisma.puzzle.findMany).toHaveBeenCalledTimes(5);
      // KS-3352: последнее окно НЕ MAX_SAFE_INTEGER (INT4 overflow),
      // а безопасные 0..4000.
      const lastCall = prisma.puzzle.findMany.mock.calls[4][0];
      expect(lastCall.where.rating).toEqual({ gte: 0, lte: 4000 });
    });

    it('override: используется одно окно, без расширения', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([]);
      const r = await service.pickNext('u-1', {
        scope: 'server',
        overrideRatingMin: 2200,
        overrideRatingMax: 2400,
      });
      expect(r).toBeNull();
      // Один call.
      expect(prisma.puzzle.findMany).toHaveBeenCalledTimes(1);
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.rating).toEqual({ gte: 2200, lte: 2400 });
    });

    it('drafts: where createdBy=userId, isPublic=false', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'd-1', rating: 1500 },
      ]);
      await service.pickNext('u-1', { scope: 'drafts' });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.createdBy).toBe('u-1');
      expect(call.where.isPublic).toBe(false);
    });

    it('published: createdBy=userId, isPublic=true', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'pp-1', rating: 1500 },
      ]);
      await service.pickNext('u-1', { scope: 'published' });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.createdBy).toBe('u-1');
      expect(call.where.isPublic).toBe(true);
    });

    it('гость с scope=drafts → принудительно server (валидное поведение)', async () => {
      prisma.puzzle.findMany.mockResolvedValueOnce([]);
      const r = await service.pickNext(null, { scope: 'drafts' });
      expect(r).toBeNull();
      // server scope без createdBy → only isPublic=true.
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.isPublic).toBe(true);
      expect(call.where.createdBy).toBeUndefined();
    });

    it('objective != "all" → themes contains фильтр в AND-блоке (KS-3357 fix)', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-obj', rating: 1500 },
      ]);
      await service.pickNext('u-1', {
        scope: 'server',
        objective: 'saveEquality',
      });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      // KS-3357 fix: themes — String (TEXT), не string[]; ранее
      // `{ has }` был мёртвым кодом (бросал бы PrismaValidation на
      // непустом objective). Теперь contains в AND-блоке.
      expect(call.where.themes).toBeUndefined();
      const andItems = call.where.AND as Array<{
        themes?: { contains: string };
      }>;
      const contains = andItems
        ?.filter((x) => x.themes !== undefined)
        .map((x) => x.themes!.contains);
      expect(contains).toEqual(['saveEquality']);
    });

    it('hideSolved=true (default) → attempts.none для user', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-h', rating: 1500 },
      ]);
      await service.pickNext('u-1', { scope: 'server' });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.attempts).toEqual({ none: { userId: 'u-1' } });
    });

    it('hideSolved=false → attempts фильтр отсутствует', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-2', rating: 1500 },
      ]);
      await service.pickNext('u-1', { scope: 'server', hideSolved: false });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      expect(call.where.attempts).toBeUndefined();
    });

    // KS-3357 / ADR-080: theme-фильтр.
    it('themesAnd=[pin,fork] → AND-цепочка contains', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-3', rating: 1500 },
      ]);
      await service.pickNext('u-1', {
        scope: 'server',
        themesAnd: ['pin', 'fork'],
      });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      // server-scope даёт OR (null/not-userId). themeAnd-фильтры
      // должны быть в where.AND-блоке (через {contains}).
      expect(call.where.AND).toBeDefined();
      const andItems = call.where.AND as Array<{
        themes?: { contains: string };
      }>;
      const themeContains = andItems
        .filter((x) => x.themes !== undefined)
        .map((x) => x.themes!.contains);
      expect(themeContains).toEqual(['pin', 'fork']);
    });

    it('themesOr=[sacrifice,trappedPiece] → OR-блок + server NULL-aware в AND', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-or', rating: 1500 },
      ]);
      await service.pickNext('u-1', {
        scope: 'server',
        themesOr: ['sacrifice', 'trappedPiece'],
      });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      // server OR (NULL-aware) был перенесён в AND-блок.
      expect(call.where.OR).toBeUndefined();
      expect(call.where.AND).toBeDefined();
      const andItems = call.where.AND as Array<{
        OR?: Array<Record<string, unknown>>;
      }>;
      // Один блок = original server OR, второй = themesOr.
      expect(andItems.length).toBeGreaterThanOrEqual(2);
      // последний AND содержит themesOr (contains).
      const themesOrBlock = andItems[andItems.length - 1];
      expect(themesOrBlock.OR).toEqual([
        { themes: { contains: 'sacrifice' } },
        { themes: { contains: 'trappedPiece' } },
      ]);
    });

    it('themes без матча на всех окнах → reason no_puzzles_for_themes', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValue([]);
      const r = await service.pickNext('u-1', {
        scope: 'server',
        themesOr: ['pin'],
      });
      expect(r).toEqual({ puzzleId: null, reason: 'no_puzzles_for_themes' });
    });

    it('без themes и без матча → null (общий no_puzzles_available)', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValue([]);
      const r = await service.pickNext('u-1', { scope: 'server' });
      expect(r).toBeNull();
    });

    it('objective + themesAnd → оба в AND-блоке (contains строки)', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1500,
      });
      prisma.puzzle.findMany.mockResolvedValueOnce([
        { id: 'p-comb', rating: 1500 },
      ]);
      await service.pickNext('u-1', {
        scope: 'server',
        objective: 'convertAdvantage',
        themesAnd: ['pin'],
      });
      const call = prisma.puzzle.findMany.mock.calls[0][0];
      const andItems = call.where.AND as Array<{
        themes?: { contains: string };
      }>;
      const contains = andItems
        .filter((x) => x.themes !== undefined)
        .map((x) => x.themes!.contains);
      expect(contains).toEqual(['convertAdvantage', 'pin']);
    });

    // ── KS-3663 / ADR-106 §2.5: maia-поля в ответе pickNext ────────
    // Фронт индикатора сложности (KS-3660/KS-3662) ожидает в DTO
    // `/precision/next` поля maiaWeakChoiceProb/maiaMetricVersion/
    // maiaTop1Elo. До KS-3663 ни select в tryPickInWindow, ни
    // pickNext-возврат их не содержали — поле в DTO было undefined,
    // фронт не рисовал блок.
    describe('KS-3663 maia-поля в ответе pickNext', () => {
      it('select запрашивает maiaWeakChoiceProb/maiaMetricVersion/maiaTop1Elo', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          {
            id: 'p-maia',
            rating: 1500,
            maiaWeakChoiceProb: 0.42,
            maiaMetricVersion: 1,
            maiaTop1Elo: 1500,
          },
        ]);
        await service.pickNext('u-1', { scope: 'server' });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.select).toEqual({
          id: true,
          rating: true,
          maiaWeakChoiceProb: true,
          maiaMetricVersion: true,
          maiaTop1Elo: true,
        });
      });

      it('размеченный пазл → maia-поля прокидываются в ответ', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          {
            id: 'p-marked',
            rating: 1500,
            maiaWeakChoiceProb: 0.42,
            maiaMetricVersion: 1,
            maiaTop1Elo: 1500,
          },
        ]);
        const r = await service.pickNext('u-1', { scope: 'server' });
        expect(r).toEqual({
          puzzleId: 'p-marked',
          rating: 1500,
          ratingDelta: 0,
          maiaWeakChoiceProb: 0.42,
          maiaMetricVersion: 1,
          maiaTop1Elo: 1500,
        });
      });

      it('неразмеченный пазл → maia-поля = null (safe fallback ADR-106 §2.6)', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          {
            id: 'p-unmarked',
            rating: 1500,
            maiaWeakChoiceProb: null,
            maiaMetricVersion: null,
            maiaTop1Elo: null,
          },
        ]);
        const r = await service.pickNext('u-1', { scope: 'server' });
        expect(r).toEqual({
          puzzleId: 'p-unmarked',
          rating: 1500,
          ratingDelta: 0,
          maiaWeakChoiceProb: null,
          maiaMetricVersion: null,
          maiaTop1Elo: null,
        });
      });
    });

    // ── KS-3661 / ADR-106 §2.6: minMaiaWeakChoiceProb ─────────────
    // Серверный фильтр precision-каталога (1:1 с KS-3656 для
    // GET /puzzles/browse). 0/undefined → без фильтра; > 0 →
    // WHERE maiaWeakChoiceProb >= v AND maiaMetricVersion = 1.
    describe('KS-3661 minMaiaWeakChoiceProb', () => {
      it('undefined → без фильтра maia в where', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-m1', rating: 1500 },
        ]);
        await service.pickNext('u-1', { scope: 'server' });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toBeUndefined();
        expect(call.where.maiaMetricVersion).toBeUndefined();
      });

      it('0 → без фильтра maia в where (1:1 с KS-3656)', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-m2', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 0,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toBeUndefined();
        expect(call.where.maiaMetricVersion).toBeUndefined();
      });

      it('0.5 → maiaWeakChoiceProb >= 0.5 + maiaMetricVersion = 1', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-m3', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 0.5,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toEqual({ gte: 0.5 });
        expect(call.where.maiaMetricVersion).toBe(1);
      });

      it('1 → maiaWeakChoiceProb >= 1 + maiaMetricVersion = 1', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-m4', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 1,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toEqual({ gte: 1 });
        expect(call.where.maiaMetricVersion).toBe(1);
      });

      it('фильтр сохраняется на расширенных окнах при пустом первом', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany
          .mockResolvedValueOnce([]) // окно 150
          .mockResolvedValueOnce([{ id: 'p-m5', rating: 1500 }]); // 300
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 0.3,
        });
        // На обоих вызовах maia-условия присутствуют.
        for (const call of prisma.puzzle.findMany.mock.calls) {
          expect(call[0].where.maiaWeakChoiceProb).toEqual({ gte: 0.3 });
          expect(call[0].where.maiaMetricVersion).toBe(1);
        }
      });

      it('фильтр совместим с themesAnd + objective (общий AND-блок не теряется)', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-m6', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          objective: 'convertAdvantage',
          themesAnd: ['pin'],
          minMaiaWeakChoiceProb: 0.4,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toEqual({ gte: 0.4 });
        expect(call.where.maiaMetricVersion).toBe(1);
        const andItems = call.where.AND as Array<{
          themes?: { contains: string };
        }>;
        const contains = andItems
          .filter((x) => x.themes !== undefined)
          .map((x) => x.themes!.contains);
        expect(contains).toEqual(['convertAdvantage', 'pin']);
      });
    });

    // KS-3670 / ADR-106 §2.6. Парная верхняя граница диапазона
    // под двусторонний ползунок KS-3665.
    describe('KS-3670 maxMaiaWeakChoiceProb', () => {
      it('undefined → без фильтра по lte', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-mx1', rating: 1500 },
        ]);
        await service.pickNext('u-1', { scope: 'server' });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toBeUndefined();
        expect(call.where.maiaMetricVersion).toBeUndefined();
      });

      it('1 → без фильтра по lte (1:1 с KS-3656 для min=0)', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-mx2', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          maxMaiaWeakChoiceProb: 1,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toBeUndefined();
        expect(call.where.maiaMetricVersion).toBeUndefined();
      });

      it('0.7 → maiaWeakChoiceProb { lte: 0.7 } + maiaMetricVersion = 1', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-mx3', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          maxMaiaWeakChoiceProb: 0.7,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toEqual({ lte: 0.7 });
        expect(call.where.maiaMetricVersion).toBe(1);
      });

      it('min=0.4 + max=0.7 → объединённый { gte, lte } + metric_version = 1', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-mx4', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 0.4,
          maxMaiaWeakChoiceProb: 0.7,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toEqual({
          gte: 0.4,
          lte: 0.7,
        });
        expect(call.where.maiaMetricVersion).toBe(1);
      });

      it('min=0 + max=1 → без фильтра (полный диапазон)', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany.mockResolvedValueOnce([
          { id: 'p-mx5', rating: 1500 },
        ]);
        await service.pickNext('u-1', {
          scope: 'server',
          minMaiaWeakChoiceProb: 0,
          maxMaiaWeakChoiceProb: 1,
        });
        const call = prisma.puzzle.findMany.mock.calls[0][0];
        expect(call.where.maiaWeakChoiceProb).toBeUndefined();
        expect(call.where.maiaMetricVersion).toBeUndefined();
      });

      it('верхняя граница сохраняется на расширенных окнах', async () => {
        prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
          rating: 1500,
        });
        prisma.puzzle.findMany
          .mockResolvedValueOnce([]) // окно 150
          .mockResolvedValueOnce([{ id: 'p-mx6', rating: 1500 }]); // 300
        await service.pickNext('u-1', {
          scope: 'server',
          maxMaiaWeakChoiceProb: 0.6,
        });
        for (const call of prisma.puzzle.findMany.mock.calls) {
          expect(call[0].where.maiaWeakChoiceProb).toEqual({ lte: 0.6 });
          expect(call[0].where.maiaMetricVersion).toBe(1);
        }
      });
    });
  });
});
