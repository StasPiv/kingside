/**
 * KS-2247. `TacticDrillSfValidatorService` юнит-тесты с моком SF.
 */
import { TacticDrillSfValidatorService } from './tactic-drill-sf-validator.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StockfishService } from '../engine/stockfish.service';

function makePrisma() {
  return {
    tacticDrill: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService & Record<string, never>;
}

function makeStockfish(): StockfishService {
  return {
    analyzeMultiPV: jest.fn(),
    analyze: jest.fn(),
  } as unknown as StockfishService;
}

describe('TacticDrillSfValidatorService — KS-2247', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let sf: StockfishService;
  let svc: TacticDrillSfValidatorService;

  beforeEach(() => {
    prisma = makePrisma();
    sf = makeStockfish();
    svc = new TacticDrillSfValidatorService(prisma as unknown as PrismaService, sf);
  });

  describe('find-mate-in-one-square', () => {
    const drill = {
      id: 'd1',
      type: 'find-mate-in-one-square',
      fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
      answer: { shape: 'square', square: 'a8' },
    };

    it('top PV = mate-in-1 на правильную to → accepted', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockResolvedValue([
        { pv: 'a1a8', bestMove: 'a1a8', score: { type: 'mate', value: 1 } },
        { pv: 'a1a7', bestMove: 'a1a7', score: { type: 'cp', value: 200 } },
      ]);
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(true);
      expect(prisma.tacticDrill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'd1' },
          data: expect.objectContaining({ sfRejected: false }),
        }),
      );
    });

    it('top PV = mate-in-1 на ДРУГУЮ to → rejected', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockResolvedValue([
        { pv: 'd1d8', bestMove: 'd1d8', score: { type: 'mate', value: 1 } },
      ]);
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/top mate to=d8/);
    });

    it('PV #2 — другой mate-in-1 → rejected (неоднозначность)', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockResolvedValue([
        { pv: 'a1a8', bestMove: 'a1a8', score: { type: 'mate', value: 1 } },
        { pv: 'd1d8', bestMove: 'd1d8', score: { type: 'mate', value: 1 } },
      ]);
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/secondary mate-in-1/);
    });

    it('top PV — не мат → rejected', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockResolvedValue([
        { pv: 'a1a4', bestMove: 'a1a4', score: { type: 'cp', value: 50 } },
      ]);
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/not mate-in-1/);
    });

    it('SF вернул пусто → rejected', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockResolvedValue([]);
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
    });

    it('SF упал → returns error verdict, БД не обновляется', async () => {
      (sf.analyzeMultiPV as jest.Mock).mockRejectedValue(new Error('boom'));
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/sf-error/);
      expect(prisma.tacticDrill.update).not.toHaveBeenCalled();
    });
  });

  describe('find-hanging-piece', () => {
    const drill = {
      id: 'd2',
      type: 'find-hanging-piece',
      fen: '4k3/8/8/4n3/4Q3/8/8/4K3 w - - 0 1',
      answer: { shape: 'square', square: 'e5' },
    };

    it('SF best move берёт hanging piece → accepted', async () => {
      // Q e4 → e5
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: 'e4e5',
        score: { type: 'cp', value: 300 },
      });
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(true);
    });

    it('SF best move — мат-в-N в другую сторону → rejected', async () => {
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: 'e4h7',
        score: { type: 'mate', value: 3 },
      });
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/sf prefers mate/);
    });

    it('SF best move — другой ход с cp ≥ 500 → rejected', async () => {
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: 'e4a8',
        score: { type: 'cp', value: 800 },
      });
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/sf prefers/);
    });

    it('SF best move — другой ход с близкой оценкой → accepted', async () => {
      // Например, +200 (есть альтернатива, но drill всё ещё валиден).
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: 'e4e6',
        score: { type: 'cp', value: 200 },
      });
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(true);
    });

    it('SF не вернул move → rejected', async () => {
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: '(none)',
      });
      const r = await svc.validateOne(drill);
      expect(r.accepted).toBe(false);
    });
  });

  describe('fetchUnvalidatedBatch', () => {
    it('берёт только mate/hanging без sfValidatedAt', async () => {
      (prisma.tacticDrill.findMany as jest.Mock).mockResolvedValue([
        { id: 'a', type: 'find-mate-in-one-square', fen: '...', answer: {} },
      ]);
      const r = await svc.fetchUnvalidatedBatch(50);
      expect(r).toHaveLength(1);
      expect(prisma.tacticDrill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: { in: ['find-mate-in-one-square', 'find-hanging-piece'] },
            sfValidatedAt: null,
          },
          take: 50,
        }),
      );
    });

    it('clamp limit до 1000', async () => {
      (prisma.tacticDrill.findMany as jest.Mock).mockResolvedValue([]);
      await svc.fetchUnvalidatedBatch(99999);
      expect(prisma.tacticDrill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1000 }),
      );
    });
  });
});
