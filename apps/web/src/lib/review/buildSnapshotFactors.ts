/**
 * KS-3712. Сборка `factors` для одного снимка позиции (`before` или
 * `after`) в теле POST `/analyses/review/move-comment`.
 *
 * Формат идентичен `position-comment` (одиночная оценка позиции):
 *   factors = [
 *     ...positionalSubterms,           // подкомпоненты от stockfish-16-trace
 *     { id: 'sf18_eval', score, ... }, // оценка позиции от SF 18
 *     { id: 'sf18_pv',   pv, ... },    // первая линия от SF 18 (UCI)
 *   ]
 *
 * Знак `score` нормализуется со стороны белых для обоих типов (`cp`
 * и `mate`), как в `useAiPositionComment` (KS-3702):
 *   value(white-pov) = sideToMove === 'b' ? -value(stm) : value(stm)
 *
 * Логика инверсии совпадает с `formatEval`/`evalToPercent` в
 * `chessFormat.ts` — той, что рисует число в `EvalBar`. Если число
 * относится к другой позиции (рассинхрон FEN), caller не должен звать
 * эту функцию — это его ответственность.
 */
import type { PositionalSubterm } from '@kingside/shared';

import type {
  MoveCommentFactor,
  MoveCommentSnapshot,
} from '../../api/moveComment';

export interface SnapshotEngineLine {
  /** SF top-1 score POV ходящей стороны на `fen` (cp или mate). */
  score: { type: 'cp' | 'mate'; value: number } | null;
  /** Глубина info-строки (информационное поле). */
  depth: number;
  /** UCI-список ходов первой линии. */
  pv: string[];
}

export interface BuildSnapshotFactorsInput {
  fen: string;
  subterms: PositionalSubterm[];
  engine: SnapshotEngineLine | null;
}

function sideToMoveFromFen(fen: string): 'w' | 'b' {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/**
 * Собирает массив `factors` для одного снимка позиции и оборачивает
 * его в `MoveCommentSnapshot` (`fen` + `factors`).
 */
export function buildSnapshotFactors(
  input: BuildSnapshotFactorsInput,
): MoveCommentSnapshot {
  const factors: MoveCommentFactor[] = [...input.subterms];
  const sideToMove = sideToMoveFromFen(input.fen);
  const engine = input.engine;

  if (engine && engine.score && Number.isFinite(engine.score.value)) {
    const normalizedScore = {
      type: engine.score.type,
      value:
        sideToMove === 'b' ? -engine.score.value : engine.score.value,
    };
    factors.push({
      id: 'sf18_eval',
      engine: 'stockfish-18',
      depth: engine.depth,
      multipv: 1,
      score: normalizedScore,
      side_to_move: sideToMove,
    });
    if (engine.pv && engine.pv.length > 0) {
      factors.push({
        id: 'sf18_pv',
        engine: 'stockfish-18',
        depth: engine.depth,
        multipv: 1,
        pv: engine.pv,
      });
    }
  }

  return { fen: input.fen, factors };
}
