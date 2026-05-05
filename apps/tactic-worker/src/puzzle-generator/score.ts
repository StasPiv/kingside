/**
 * KS-2431. Helpers для работы с Stockfish-score (cp / mate).
 *
 * Все score'ы из Stockfish — relative to side to move. При сравнении
 * eval'ов **до** и **после** хода (blunder detection) важно учесть
 * смену стороны:
 *
 *   - Если до хода Stockfish сказал «у белых +500cp» (это `+500` от
 *     стороны на ходу — белых), и после хода Stockfish говорит
 *     «у чёрных +200cp» (это `+200` от стороны на ходу — чёрных,
 *     т.е. для белых это `-200cp`), то реальный eval для оригинальной
 *     стороны (белых) опустился с +500 до -200, drop = 700cp.
 *
 * `cpFromSide(score, asSide, sideToMove)` приводит score из «relative to
 * side-to-move» в «from POV of `asSide`». Для матовых оценок mate-in-N
 * → +inf или -inf (мы конвертируем mate в условные cp по формуле
 * 100_000 - matedist для отбраковки на численных порогах).
 */
import type { ScoreCp } from '../stockfish/stockfish.service';

/** Условный «cp-эквивалент» матовой оценки (для сравнений). */
const MATE_CP_BASE = 100_000;

/** cp от лица side. side === 'w' | 'b', sideToMove = к кому относится score. */
export function cpFromSide(
  score: ScoreCp,
  asSide: 'w' | 'b',
  sideToMove: 'w' | 'b',
): number {
  let cp: number;
  if (score.type === 'cp') {
    cp = score.value;
  } else {
    // mate. value > 0 — мат за стороной на ходу за value полуходов;
    // value < 0 — мат против стороны на ходу.
    const sign = score.value >= 0 ? 1 : -1;
    cp = sign * (MATE_CP_BASE - Math.abs(score.value));
  }
  // Если запросили POV другой стороны — инвертируем.
  return asSide === sideToMove ? cp : -cp;
}

/** «Mate ли это», без знака. */
export function isMateScore(score: ScoreCp): boolean {
  return score.type === 'mate';
}

/** Знак мата — true если мат в пользу side-to-move. */
export function isMateForSideToMove(score: ScoreCp): boolean {
  return score.type === 'mate' && score.value > 0;
}

/** Проверка: оценка ≥ +200cp от лица side. */
export function isCrushingForSide(
  score: ScoreCp,
  asSide: 'w' | 'b',
  sideToMove: 'w' | 'b',
  thresholdCp: number,
): boolean {
  return cpFromSide(score, asSide, sideToMove) >= thresholdCp;
}
