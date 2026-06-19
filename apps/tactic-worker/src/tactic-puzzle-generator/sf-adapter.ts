/**
 * KS-4340 / ADR-135 §2.3. Адаптер `StockfishService` →
 * `TacticSfEngine` из shared. Конкретные обязанности:
 *   * фиксируем режим `go nodes` (без depth/time) — server-вариант
 *     алгоритма, см. ADR-135 §2.3;
 *   * собираем `E` (expected score) из WDL по формуле
 *     `(W + D/2)/1000`, с mate-fallback через `wdlOrMateFallback`;
 *   * если SF не отдал ни WDL, ни mate (cp без WDL — теоретически
 *     невозможно при `UCI_ShowWDL=true`), используем формулу lichess
 *     `1/(1+exp(-k·cp))` ради устойчивости и помечаем `wdl=null` —
 *     shared дальше отбракует такой кандидат как `engineError`.
 *
 * `maxDepth` для серверного `go nodes`-режима не извлекаем — `searchMultiPV`
 * наружу не отдаёт глубину, а в БД `tactic_puzzles.depth` колонки нет
 * (ADR-135 §2.1 не предусматривает). Возвращаем 0; кандидат-метрика
 * `depth` идёт только в Prisma как `Int @default(0)`-эквивалент через
 * sourceMetadata в случае надобности — в текущей модели её нет.
 */
import {
  expectedScoreFromWdl,
  wdlOrMateFallback,
  type TacticSfEngine,
  type TacticSfLine,
} from '@kingside/shared';
import type { StockfishService } from '../stockfish/stockfish.service';

export function makeTacticSfEngine(sf: StockfishService): TacticSfEngine {
  return {
    async analyze(fen, multiPV, nodes, ctx) {
      const lines = await sf.analyzePositionWdl(
        fen,
        { nodes },
        multiPV,
        ctx?.label,
      );
      const tacticLines: TacticSfLine[] = lines.map((l) => {
        const wdl = wdlOrMateFallback(l.wdl ?? null, l.score);
        let E: number;
        if (wdl) {
          E = expectedScoreFromWdl(wdl);
        } else if (l.score.type === 'mate') {
          // Защита от чужой реализации wdlOrMateFallback; теоретически
          // mate-ветка уже отработана выше.
          E = l.score.value > 0 ? 1 : 0;
        } else {
          // cp без WDL — мaловероятный путь, lichess-формула.
          E = 1 / (1 + Math.exp(-0.00368208 * l.score.value));
        }
        return { move: l.bestMove, E, wdl };
      });
      return { lines: tacticLines, maxDepth: 0 };
    },
  };
}
