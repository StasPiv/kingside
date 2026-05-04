/**
 * KS-2230. Юнит-тесты `TacticDrillService`.
 *
 * Покрытие:
 *   - listTypes(null) и listTypes(userId);
 *   - getNext без cooldown (гость) и с cooldown (auth);
 *   - getNext возвращает DTO без `answer` (api-contract §7);
 *   - recordAttempt: гость не пишет в БД, auth — пишет;
 *   - getMyStats — агрегация per-type.
 */

import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import type { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  return {
    tacticDrill: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    tacticDrillAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    tacticDrillSprintScore: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    lessonStep: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // KS-2368: $queryRawUnsafe для balanced count-attackers (raw SQL).
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  } as unknown as PrismaService & Record<string, never>;
}

describe('TacticDrillService — KS-2230', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: TacticDrillService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new TacticDrillService(
      prisma as unknown as PrismaService,
      new TacticDrillValidatorService(),
    );
  });

  describe('listTypes', () => {
    it('null user → 8 типов, все unlocked', async () => {
      const types = await svc.listTypes(null);
      expect(types).toHaveLength(8);
      for (const t of types) {
        expect(t.unlocked).toBe(true);
        expect(typeof t.promptKey).toBe('string');
        expect(t.promptKey).toContain('review.drill.prompt.');
      }
    });

    it('auth user → запрашивает solved-attempts (не падает на пустых)', async () => {
      // findMany по solved attempts → []. unlock-логика MVP всё равно
      // оставляет all unlocked.
      (prisma.tacticDrillAttempt.findMany as jest.Mock).mockResolvedValue([]);
      const types = await svc.listTypes('user-1');
      expect(types).toHaveLength(8);
      expect(prisma.tacticDrillAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', correct: true },
        }),
      );
    });
  });

  describe('getNext', () => {
    it('пул пустой → null', async () => {
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(0);
      const r = await svc.getNext(null, 'find-fork');
      expect(r).toBeNull();
    });

    it('гость → cooldown не применяется (нет findMany по attempt)', async () => {
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-1',
        type: 'find-fork',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        difficulty: 2,
      });
      const r = await svc.getNext(null, 'find-fork');
      expect(r).toBeDefined();
      expect(prisma.tacticDrillAttempt.findMany).not.toHaveBeenCalled();
    });

    it('auth user → cooldown 30 дней; recent drillIds исключаются', async () => {
      (prisma.tacticDrillAttempt.findMany as jest.Mock).mockResolvedValue([
        { drillId: 'recent-1' },
        { drillId: 'recent-2' },
      ]);
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(5);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-new',
        type: 'find-fork',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        difficulty: 2,
      });
      await svc.getNext('user-1', 'find-fork');
      expect(prisma.tacticDrill.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'find-fork',
            id: { notIn: ['recent-1', 'recent-2'] },
          }),
        }),
      );
    });

    it('возвращает DTO БЕЗ поля `answer` (api-contract §7)', async () => {
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-1',
        type: 'find-fork',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        difficulty: 3,
      });
      const r = await svc.getNext(null, 'find-fork');
      expect(r).toBeDefined();
      // critical: no `answer` key
      expect(r as unknown as Record<string, unknown>).not.toHaveProperty(
        'answer',
      );
      expect(r?.id).toBe('drill-1');
      expect(r?.drillType).toBe('find-fork');
      expect(r?.answerShape).toBe('square');
    });

    it('select-clause НЕ выбирает answer из БД', async () => {
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'd',
        type: 'find-fork',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        difficulty: 1,
      });
      await svc.getNext(null, 'find-fork');
      const call = (prisma.tacticDrill.findFirst as jest.Mock).mock.calls[0][0];
      expect(call.select).toEqual(
        expect.objectContaining({
          id: true,
          type: true,
          fen: true,
          difficulty: true,
        }),
      );
      expect(call.select).not.toHaveProperty('answer');
    });

    it('side-to-move = null для find-pin / find-loose / count-attackers', async () => {
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'd',
        type: 'find-pin',
        fen: '2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1',
        difficulty: 1,
      });
      const r = await svc.getNext(null, 'find-pin');
      expect(r?.sideToMove).toBeNull();
    });

    it('KS-2369: count-attackers DTO пробрасывает meta.attackerColor', async () => {
      // KS-2371: keyset-формат. Первый value: fwd[]  → bwd[]  → null.
      // Второй value: fwd с drill (содержит meta).
      const queryMock = prisma.$queryRawUnsafe as jest.Mock;
      queryMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'd-ca-meta',
            type: 'count-attackers',
            fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
            difficulty: 3,
            meta: { highlightedSquare: 'e4', attackerColor: 'b' },
          },
        ]);
      const r = await svc.getNext(null, 'count-attackers');
      expect(r?.meta?.highlightedSquare).toBe('e4');
      expect(r?.meta?.attackerColor).toBe('b');
    });

    it('KS-2346/2368/2371: count-attackers через keyset random (gen_random_uuid)', async () => {
      // KS-2371: переписано с count+offset на keyset через `id >=
      // gen_random_uuid()`. На один value до 2 запросов: forward
      // (id >= ...) и backward fallback. Имитируем: 3 value пусты
      // (fwd []  → bwd [] = 6 пустых ответов), 4-й value: fwd [row].
      const queryMock = prisma.$queryRawUnsafe as jest.Mock;
      queryMock
        .mockResolvedValueOnce([]) // value-1 fwd
        .mockResolvedValueOnce([]) // value-1 bwd
        .mockResolvedValueOnce([]) // value-2 fwd
        .mockResolvedValueOnce([]) // value-2 bwd
        .mockResolvedValueOnce([]) // value-3 fwd
        .mockResolvedValueOnce([]) // value-3 bwd
        .mockResolvedValueOnce([
          {
            id: 'd-ca',
            type: 'count-attackers',
            fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
            difficulty: 2,
            meta: { highlightedSquare: 'd4' },
          },
        ]);
      const r = await svc.getNext(null, 'count-attackers');
      expect(r?.id).toBe('d-ca');
      // Проверяем, что raw SQL использует keyset (gen_random_uuid).
      const calls = queryMock.mock.calls;
      const hasKeyset = calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('gen_random_uuid()') &&
          c[0].includes("answer->>'value'"),
      );
      expect(hasKeyset).toBe(true);
    });

    it('KS-2346/2368: count-attackers пул пуст по всем value → null', async () => {
      // Все попытки (4×fwd + 4×bwd) возвращают [] → null.
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
      const r = await svc.getNext(null, 'count-attackers');
      expect(r).toBeNull();
    });
  });

  describe('recordAttempt', () => {
    const drillRow = {
      id: 'drill-1',
      answer: { shape: 'square', square: 'e4' },
    };

    beforeEach(() => {
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue(drillRow);
    });

    it('гость: правильный ответ → solved, в БД НЕ пишется', async () => {
      const r = await svc.recordAttempt(
        null,
        'drill-1',
        { shape: 'square', square: 'e4' },
        1500,
      );
      expect(r.solved).toBe(true);
      expect(r.correctAnswer).toEqual({ shape: 'square', square: 'e4' });
      expect(prisma.tacticDrillAttempt.create).not.toHaveBeenCalled();
      expect(r.attemptId.startsWith('guest-')).toBe(true);
    });

    it('auth: неправильный ответ → solved=false, запись в БД', async () => {
      (prisma.tacticDrillAttempt.create as jest.Mock).mockResolvedValue({
        id: 'attempt-1',
      });
      const r = await svc.recordAttempt(
        'user-1',
        'drill-1',
        { shape: 'square', square: 'd4' },
        2000,
      );
      expect(r.solved).toBe(false);
      expect(r.attemptId).toBe('attempt-1');
      expect(prisma.tacticDrillAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            drillId: 'drill-1',
            correct: false,
            timeMs: 2000,
          }),
        }),
      );
    });

    it('drill не существует → NotFoundException', async () => {
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        svc.recordAttempt(
          null,
          'unknown',
          { shape: 'square', square: 'e4' },
          0,
        ),
      ).rejects.toThrow();
    });
  });

  describe('getMyStats', () => {
    it('пустые попытки → all zeroes, unlocked=[]', async () => {
      (prisma.tacticDrillAttempt.findMany as jest.Mock).mockResolvedValue([]);
      const r = await svc.getMyStats('user-1');
      expect(r.total.attempts).toBe(0);
      expect(r.total.accuracy).toBe(0);
      expect(r.unlocked).toEqual([]);
      expect(r.byType).toHaveLength(8);
    });

    it('агрегация per-type корректна', async () => {
      (prisma.tacticDrillAttempt.findMany as jest.Mock).mockResolvedValue([
        { correct: true, timeMs: 1000, drill: { type: 'find-fork' } },
        { correct: true, timeMs: 2000, drill: { type: 'find-fork' } },
        { correct: false, timeMs: 5000, drill: { type: 'find-fork' } },
        { correct: true, timeMs: 800, drill: { type: 'find-pin' } },
      ]);
      const r = await svc.getMyStats('user-1');
      expect(r.total.attempts).toBe(4);
      expect(r.total.solved).toBe(3);
      expect(r.total.accuracy).toBe(0.75);
      const fork = r.byType.find((b) => b.drillType === 'find-fork')!;
      expect(fork.attempts).toBe(3);
      expect(fork.solved).toBe(2);
      expect(fork.accuracy).toBeCloseTo(0.67, 2);
      expect(fork.avgTimeMs).toBe(1500);
      const pin = r.byType.find((b) => b.drillType === 'find-pin')!;
      expect(pin.solved).toBe(1);
      expect(pin.avgTimeMs).toBe(800);
      expect(r.unlocked.sort()).toEqual(['find-fork', 'find-pin']);
    });
  });

  // ─── KS-2315: pickDrillForLesson (резолвер /tactic-drill/by-step) ──

  describe('pickDrillForLesson (KS-2315)', () => {
    const STEP_ID = '11111111-1111-1111-1111-111111111111';
    const DRILL_ID = '22222222-2222-2222-2222-222222222222';

    it('step не найден → 404 NotFoundException', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /lesson step not found/,
      );
    });

    it('step есть, но type != "drill" → 400 BadRequestException', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'text',
        payload: { type: 'text', bodyMarkdown: 'hello' },
      });
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /is not a drill/,
      );
    });

    it('payload malformed (нет drillType) → 400', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill' /* drillType отсутствует */ },
      });
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /malformed/,
      );
    });

    it('fixed drillId → возвращает тот drill (без cooldown)', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork', drillId: DRILL_ID },
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue({
        id: DRILL_ID,
        type: 'find-fork',
        fen: '4k3/8/8/4r3/2N5/q7/8/4K3 w - - 0 1',
        difficulty: 3,
        sfRejected: false,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.drill.id).toBe(DRILL_ID);
      expect(r.drill.drillType).toBe('find-fork');
      expect(r.drill.difficulty).toBe(3);
      // Должен быть БЕЗ answer (api-contract §7).
      expect((r.drill as unknown as Record<string, unknown>).answer).toBeUndefined();
      expect(r.stepMeta).toEqual({ stepId: STEP_ID, count: 1, minSolved: 1 });
    });

    it('fixed drillId, drill отсутствует → 404', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork', drillId: DRILL_ID },
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /no drill available/,
      );
    });

    it('fixed drillId, sfRejected=true → 404', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork', drillId: DRILL_ID },
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue({
        id: DRILL_ID,
        type: 'find-fork',
        fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
        difficulty: 3,
        sfRejected: true,
      });
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /no drill available/,
      );
    });

    it('fixed drillId, drillType подменён → 404 (защита от подмены)', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-pin', drillId: DRILL_ID },
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue({
        id: DRILL_ID,
        type: 'find-fork',
        fen: '4k3/8/8/4r3/2N5/q7/8/4K3 w - - 0 1',
        difficulty: 3,
        sfRejected: false,
      });
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /no drill available/,
      );
    });

    it('random + bucket=easy → WHERE difficulty IN [1,2]', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-fork',
          difficultyBucket: 'easy',
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(5);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-easy',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 1,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.drill.id).toBe('drill-easy');
      // Проверяем что count вызвался с difficulty IN [1,2].
      const countCall = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.type).toBe('find-fork');
      expect(countCall.where.sfRejected).toBe(false);
      expect(countCall.where.difficulty).toEqual({ in: [1, 2] });
    });

    it('random + bucket=medium → difficulty IN [3]', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-pin',
          difficultyBucket: 'medium',
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(2);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-mid',
        type: 'find-pin',
        fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
        difficulty: 3,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.drill.id).toBe('drill-mid');
      const countCall = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.difficulty).toEqual({ in: [3] });
    });

    it('random + bucket=hard → difficulty IN [4,5]', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-fork',
          difficultyBucket: 'hard',
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-hard',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 5,
      });
      await svc.pickDrillForLesson(STEP_ID);
      const countCall = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.difficulty).toEqual({ in: [4, 5] });
    });

    it('random без bucket → без фильтра difficulty', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork' },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(10);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-any',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 2,
      });
      await svc.pickDrillForLesson(STEP_ID);
      const countCall = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.type).toBe('find-fork');
      expect(countCall.where.difficulty).toBeUndefined();
    });

    it('random + bucket=easy пустой → fallback на любой drill', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-fork',
          difficultyBucket: 'easy',
        },
      });
      // Первый count — bucket-фильтр пустой; второй count — fallback,
      // в нём 3 drill'а.
      const countMock = prisma.tacticDrill.count as jest.Mock;
      countMock.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-fallback',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 4,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.drill.id).toBe('drill-fallback');
      // Должно быть 2 вызова count (bucket-фильтр + fallback).
      expect(countMock).toHaveBeenCalledTimes(2);
      expect(countMock.mock.calls[0][0].where.difficulty).toEqual({ in: [1, 2] });
      expect(countMock.mock.calls[1][0].where.difficulty).toBeUndefined();
    });

    it('random — оба пула пустые → 404', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-fork',
          difficultyBucket: 'hard',
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(0);
      await expect(svc.pickDrillForLesson(STEP_ID)).rejects.toThrow(
        /no drill available/,
      );
    });

    it('count + minSolved пробрасываются в stepMeta', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: 'find-fork',
          count: 5,
          minSolved: 3,
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-x',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 3,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.stepMeta).toEqual({ stepId: STEP_ID, count: 5, minSolved: 3 });
    });

    it('count указан, minSolved нет → minSolved дефолтится на count', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork', count: 7 },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-y',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 3,
      });
      const r = await svc.pickDrillForLesson(STEP_ID);
      expect(r.stepMeta).toEqual({ stepId: STEP_ID, count: 7, minSolved: 7 });
    });

    it('sfRejected=false фильтр всегда применяется', async () => {
      (prisma.lessonStep.findUnique as jest.Mock).mockResolvedValue({
        id: STEP_ID,
        type: 'drill',
        payload: { type: 'drill', drillType: 'find-fork' },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-z',
        type: 'find-fork',
        fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
        difficulty: 3,
      });
      await svc.pickDrillForLesson(STEP_ID);
      const countCall = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.sfRejected).toBe(false);
    });
  });
});
