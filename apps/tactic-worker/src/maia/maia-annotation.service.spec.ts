/**
 * KS-3633 / KS-3640 / ADR-104 §5 → ADR-106 §2.1. Unit-тесты
 * MaiaAnnotationService v2.
 *
 * Реальный ONNX-инфер не запускаем (модели нет в test-окружении и она
 * 44 МБ). Pure-логика weak_choice вынесена в `@kingside/maia-core` —
 * там покрыта детально. Здесь — orchestration:
 *  - feature-flag `PRECISION_MAIA_ANNOTATION_ENABLED=false` → disabled;
 *  - ENV-парсинг (ELO дефолтный 1500, SF-depth дефолтный 15);
 *  - graceful: отсутствующий MODEL_PATH → null + kill-switch initFailed;
 *  - happy-path с подменённым Maia engine (через приватный setter)
 *    и моком StockfishService — проверяем что данные текут через
 *    `buildMaiaSearchMoves` + `analyzePositionWdl(searchmoves)` +
 *    `computeWeakChoiceProb` и итог корректный.
 *  - SF-исключение → null (caller записывает NULL'ы).
 */
import { MaiaAnnotationService } from './maia-annotation.service';
import type { StockfishService, MultiPvLine } from '../stockfish/stockfish.service';
import { MAIA_WEAK_CHOICE_METRIC_VERSION } from '@kingside/maia-core';

/** Минимальный мок StockfishService, без реального spawn. */
function mockStockfish(
  analyzeImpl?: (
    fen: string,
    limit: unknown,
    multiPV: number,
    label?: string,
    earlyStop?: unknown,
    searchMoves?: string[],
  ) => Promise<MultiPvLine[]>,
): StockfishService {
  return {
    analyzePositionWdl: jest.fn(analyzeImpl ?? (() => Promise.resolve([]))),
  } as unknown as StockfishService;
}

/**
 * Inject заранее созданный fake-Maia engine в сервис (минуя ONNX-init).
 * Поле `maia` приватное, доступ через any — это test-only трюк.
 */
function injectFakeMaia(
  svc: MaiaAnnotationService,
  predictMoves: (
    fen: string,
    eloSelf: number,
    eloOppo: number,
  ) => Promise<{
    policy: Array<{ move: string; probability: number }>;
    winProbability: number;
  }>,
): void {
  const fakeMaia = {
    predictMoves: jest.fn(predictMoves),
    ensureSession: jest.fn(() => Promise.resolve({})),
  };
  (svc as unknown as { maia: unknown; initFailed: boolean }).maia = fakeMaia;
  (svc as unknown as { initFailed: boolean }).initFailed = false;
}

describe('MaiaAnnotationService', () => {
  describe('fromEnv', () => {
    it('default ENV → enabled, ELO 1500, SF-depth 15', () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {});
      expect(svc.isEnabled()).toBe(true);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=false → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {
        PRECISION_MAIA_ANNOTATION_ENABLED: 'false',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=0 → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {
        PRECISION_MAIA_ANNOTATION_ENABLED: '0',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=off → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {
        PRECISION_MAIA_ANNOTATION_ENABLED: 'off',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=ON → enabled', () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {
        PRECISION_MAIA_ANNOTATION_ENABLED: 'ON',
      });
      expect(svc.isEnabled()).toBe(true);
    });
  });

  describe('annotate (disabled-режим)', () => {
    it('disabled → возвращает null без попытки загрузки модели', async () => {
      const sf = mockStockfish();
      const svc = MaiaAnnotationService.fromEnv(sf, {
        PRECISION_MAIA_ANNOTATION_ENABLED: 'false',
      });
      const result = await svc.annotate(
        'puzzle-1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(result).toBeNull();
      expect(sf.analyzePositionWdl).not.toHaveBeenCalled();
    });
  });

  describe('annotate (graceful при отсутствии модели)', () => {
    it('несуществующий MODEL_PATH → null + kill-switch initFailed', async () => {
      const svc = MaiaAnnotationService.fromEnv(mockStockfish(), {
        PRECISION_MAIA_ANNOTATION_ENABLED: 'true',
        PRECISION_MAIA_MODEL_PATH: '/nonexistent/path/to/maia.onnx',
        PRECISION_MAIA_ANNOTATION_ELO: '1500',
      });

      // Первый вызов: пытаемся загрузить, FS-ошибка → null. После этого
      // initFailed = true → сервис фактически disabled на дальнейших.
      const first = await svc.annotate(
        'p-1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(first).toBeNull();
      expect(svc.isEnabled()).toBe(false);

      // Второй вызов: сразу null, без повторной попытки загрузки.
      const second = await svc.annotate(
        'p-2',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(second).toBeNull();
    }, 30000);
  });

  describe('annotate (happy path с моком Maia + SF, ADR-106 §2.1)', () => {
    // FEN-заглушка — реально парсится только preprocessMaia3 которую мы
    // обходим через подменённый engine.
    const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    it('однозначная позиция: один сильный кандидат → weakChoiceProb=0', async () => {
      // Maia: 'best'=0.85 (>0.10), остальные ≤0.10 → MaiaTopK={best}.
      // SF eval 'best' (единственный searchmove): w=900/d=50/l=50 → E=0.925.
      // weak_set пустой → 0.
      const sf = mockStockfish(async (_fen, _limit, _mpv, _label, _es, searchMoves) => {
        expect(searchMoves).toEqual(['best']);
        return [
          {
            pv: 'best ...',
            score: { type: 'cp', value: 200 },
            bestMove: 'best',
            wdl: { w: 900, d: 50, l: 50 },
          },
        ];
      });
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [
          { move: 'best', probability: 0.85 },
          { move: 'noise', probability: 0.08 },
        ],
        winProbability: 0.9,
      }));

      const r = await svc.annotate('p-unique', FEN, 'best');
      expect(r).toEqual({
        weakChoiceProb: 0,
        metricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
        elo: 1500,
        latencyMs: expect.any(Number),
      });
    });

    it('один слабый ход в MaiaTopK → weakChoiceProb = policy(weak)', async () => {
      // Maia: best=0.6, weak=0.35; firstMovePV1='best'.
      // SF eval: best E=0.9, weak E=0.3 → loss=0.6 ≫ 0.025 → weight=1.
      // → weakChoiceProb = 0.35 · 1 = 0.35.
      const sf = mockStockfish(async () => [
        {
          pv: 'best ...',
          score: { type: 'cp', value: 300 },
          bestMove: 'best',
          wdl: { w: 900, d: 0, l: 100 },
        },
        {
          pv: 'weak ...',
          score: { type: 'cp', value: -50 },
          bestMove: 'weak',
          wdl: { w: 250, d: 100, l: 650 },
        },
      ]);
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [
          { move: 'best', probability: 0.6 },
          { move: 'weak', probability: 0.35 },
        ],
        winProbability: 0.7,
      }));

      const r = await svc.annotate('p-weak', FEN, 'best');
      expect(r).not.toBeNull();
      expect(r!.weakChoiceProb).toBeCloseTo(0.35, 6);
      expect(r!.metricVersion).toBe(MAIA_WEAK_CHOICE_METRIC_VERSION);
      expect(r!.elo).toBe(1500);
    });

    it('равно-сильные ходы (loss ≤ 0.015) → weakChoiceProb=0', async () => {
      // best E=0.5, alt E=0.49 → loss=0.01 (≤ нижней границы
      // soft-threshold 0.015) → weight=0 → НЕ слабый.
      const sf = mockStockfish(async () => [
        {
          pv: 'best',
          score: { type: 'cp', value: 0 },
          bestMove: 'best',
          wdl: { w: 500, d: 0, l: 500 },
        },
        {
          pv: 'alt',
          score: { type: 'cp', value: -10 },
          bestMove: 'alt',
          wdl: { w: 490, d: 0, l: 510 },
        },
      ]);
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [
          { move: 'best', probability: 0.55 },
          { move: 'alt', probability: 0.4 },
        ],
        winProbability: 0.5,
      }));

      const r = await svc.annotate('p-equal', FEN, 'best');
      expect(r!.weakChoiceProb).toBe(0);
    });

    it('mate-fallback: SF без WDL для mate-линии → expectedScore=1.0 при mate в нашу пользу', async () => {
      // weak — mate против → E≈0; best — mate за → E≈1.
      const sf = mockStockfish(async () => [
        {
          pv: 'best',
          score: { type: 'mate', value: 3 },
          bestMove: 'best',
          wdl: null, // SF без WDL на mate
        },
        {
          pv: 'weak',
          score: { type: 'cp', value: -200 },
          bestMove: 'weak',
          wdl: { w: 100, d: 100, l: 800 },
        },
      ]);
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [
          { move: 'best', probability: 0.5 },
          { move: 'weak', probability: 0.4 },
        ],
        winProbability: 0.95,
      }));

      const r = await svc.annotate('p-mate', FEN, 'best');
      // best mate-fallback → wdl 1000/0/0 → E=1.0. weak → E=0.15. loss=0.85 → слабый.
      expect(r!.weakChoiceProb).toBeCloseTo(0.4, 6);
    });
  });

  describe('annotate (graceful при сбоях)', () => {
    it('Maia inference exception → null', async () => {
      const sf = mockStockfish();
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => {
        throw new Error('synthetic-maia-fail');
      });
      const r = await svc.annotate(
        'p-maia-fail',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(r).toBeNull();
      expect(sf.analyzePositionWdl).not.toHaveBeenCalled();
    });

    it('SF analyzePositionWdl exception → null', async () => {
      const sf = mockStockfish(async () => {
        throw new Error('synthetic-sf-fail');
      });
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [{ move: 'best', probability: 0.8 }],
        winProbability: 0.7,
      }));
      const r = await svc.annotate(
        'p-sf-fail',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'best',
      );
      expect(r).toBeNull();
    });

    it('Maia вернул пустой policy → null (нет легальных)', async () => {
      const sf = mockStockfish();
      const svc = MaiaAnnotationService.fromEnv(sf, {});
      injectFakeMaia(svc, async () => ({
        policy: [],
        winProbability: 0,
      }));
      const r = await svc.annotate(
        'p-empty',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(r).toBeNull();
      expect(sf.analyzePositionWdl).not.toHaveBeenCalled();
    });
  });
});
