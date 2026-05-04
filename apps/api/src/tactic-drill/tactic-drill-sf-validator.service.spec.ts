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

  // KS-2393: describe `mate-in-1 (deprecated)` удалён вместе с типом.
  // Метод validateMateInOne не существует.

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

    it('KS-2337: shape="move" принимается, target из answer.to', async () => {
      // После KS-2337 find-hanging-piece имеет shape='move'. Validator
      // должен извлекать target из answer.to и не отказывать на shape.
      const moveDrill = {
        id: 'd2-move',
        type: 'find-hanging-piece',
        fen: '4k3/8/8/4n3/4Q3/8/8/4K3 w - - 0 1',
        answer: { shape: 'move', from: 'e4', to: 'e5' },
      };
      (sf.analyze as jest.Mock).mockResolvedValue({
        bestMove: 'e4e5',
        score: { type: 'cp', value: 300 },
      });
      const r = await svc.validateOne(moveDrill);
      expect(r.accepted).toBe(true);
    });
  });

  describe('fetchUnvalidatedBatch', () => {
    // KS-2393: после удаления mate-in-1 (deprecated) фильтр —
    // только find-hanging-piece.
    it('берёт только find-hanging-piece без sfValidatedAt', async () => {
      (prisma.tacticDrill.findMany as jest.Mock).mockResolvedValue([
        { id: 'a', type: 'find-hanging-piece', fen: '...', answer: {} },
      ]);
      const r = await svc.fetchUnvalidatedBatch(50);
      expect(r).toHaveLength(1);
      expect(prisma.tacticDrill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: 'find-hanging-piece',
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
