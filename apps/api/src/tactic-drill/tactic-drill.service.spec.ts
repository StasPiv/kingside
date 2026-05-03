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
});
