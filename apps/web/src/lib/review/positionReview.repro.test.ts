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

  it('KS-4979: одиночный ответ Maia НЕ обрывает разбор theory, ход доигрывается', async () => {
    // Замерено в KS-4978: на near-equal позиции с одним доминирующим ответом
    // Maia (второй кандидат отсекается порогом pFloor) разбор ставил ложную
    // theory на 1-м ходу. Вариант «а» (KS-4979): одиночный ответ доигрывается.
    const ROOT = 'root w - - 0 1';
    const AFTER = 'after b - - 0 1'; // после нашего хода, ход соперника
    const REPLY = 'reply w - - 0 2'; // после единственного ответа соперника
    const engines: PositionReviewEngines = {
      // Один доминирующий ответ соперника (после нашего хода).
      getMaiaPolicy: async (fen): Promise<Record<string, number>> =>
        fen === AFTER ? { m1m1: 0.95 } : {},
      analyze: async (fen) =>
        nearEqual(fen === ROOT ? 'r1r1' : fen === AFTER ? 's1s1' : null),
      applyMove: (fen, uci) =>
        fen === ROOT ? AFTER : fen === AFTER && uci === 'm1m1' ? REPLY : null,
      toSan: (_f, u) => u,
    };
    const plan = await buildReviewPlan(ROOT, engines);
    // theory по одиночному ответу больше не ставится.
    expect(plan.stats.leaves.theory).toBe(0);
    const moves = plan.ops
      .filter((o) => o.type === 'move')
      .map((o) => (o as { uci: string }).uci);
    expect(moves).toContain('r1r1'); // наш ход построен
    expect(moves).toContain('m1m1'); // единственный ответ соперника доигран
  });
});
