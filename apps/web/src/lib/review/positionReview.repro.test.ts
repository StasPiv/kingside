import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
  buildReviewPlan,
  reviewConfigForPreset,
  type PositionReviewEngines,
  type PositionReviewEval,
} from './positionReview';

// KS-4975: на проде Maia отдавала пустую policy → разбор выдавал мусор
// «Готово: 1 вариант, глубина 0» + ложную метку «[%exit theory] дебют
// пройден» после одного хода SF. Здесь фиксируем деградацию (Maia пусто)
// и проверяем, что разбор строит осмысленную линию силами Stockfish, а
// ложной theory не появляется.

const MIDGAME = 'r3k2r/1p2bppp/p1n1b3/8/8/1N2B3/PPPRB1PP/2K4R w - - 0 1';

const nearEqual = (best: string | null): PositionReviewEval => ({
  bestUci: best,
  wdl: { w: 333, d: 334, l: 333 },
  multipv: best ? [best] : [],
  score: { type: 'cp', value: 0 },
});

/** SF жив (даёт первый легальный ход как «лучший»), Maia пуста. */
function enginesEmptyMaia(): PositionReviewEngines {
  const firstLegal = (fen: string): string | null => {
    try {
      const c = new Chess(fen);
      const m = c.moves({ verbose: true })[0];
      return m ? `${m.from}${m.to}${m.promotion ?? ''}` : null;
    } catch {
      return null;
    }
  };
  return {
    getMaiaPolicy: async () => ({}), // деградация Maia
    analyze: async (fen) => nearEqual(firstLegal(fen)),
    applyMove: (fen, uci) => {
      try {
        const c = new Chess(fen);
        const mv = c.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        return mv ? c.fen() : null;
      } catch {
        return null;
      }
    },
    toSan: (fen, uci) => {
      try {
        const c = new Chess(fen);
        const mv = c.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        return mv?.san ?? uci;
      } catch {
        return uci;
      }
    },
  };
}

describe('KS-4975 — разбор при пустой Maia не выдаёт ложную theory', () => {
  it('строит SF-линию (>1 хода, глубина > 0), theory=0', async () => {
    const plan = await buildReviewPlan(
      MIDGAME,
      enginesEmptyMaia(),
      reviewConfigForPreset('standard'),
    );
    const moves = plan.ops.filter((o) => o.type === 'move');
    // Ложной «дебют пройден» быть не должно.
    expect(plan.stats.leaves.theory).toBe(0);
    // Разбор задействовал движок и построил осмысленную линию.
    expect(moves.length).toBeGreaterThan(1);
    expect(plan.stats.maxPlyReached).toBeGreaterThan(0);
    // Ветка закрыта легитимной причиной (depth/transposition/terminal/…),
    // а не мусорной theory глубины 0.
    const total = Object.values(plan.stats.leaves).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('одиночный форсированный ответ Maia → theory (ADR §4, поведение сохранено)', async () => {
    // Maia отдаёт РОВНО один ход соперника (forced) → near-equal → theory.
    const ROOT = 'root w - - 0 1';
    const AFTER = 'after b - - 0 1';
    const engines: PositionReviewEngines = {
      getMaiaPolicy: async (fen): Promise<Record<string, number>> =>
        fen === AFTER ? { m1m1: 0.95 } : {},
      analyze: async (fen) => nearEqual(fen === ROOT ? 'r1r1' : 's1s1'),
      applyMove: (fen) => (fen === ROOT ? AFTER : null),
      toSan: (_f, u) => u,
    };
    const plan = await buildReviewPlan(ROOT, engines);
    expect(plan.stats.leaves.theory).toBe(1);
  });
});
