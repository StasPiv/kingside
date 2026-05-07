/**
 * KS-2431 (WDL pivot) → KS-2583 (вынос WDL-утилит в shared).
 *
 * Pipeline puzzle-generator переведён на источник «выигрышные шансы»
 * из UCI_ShowWDL (per-mille W/D/L), а не на cp-сигмоиду lichess.
 * Причина: Stockfish WDL — нативная NNUE-оценка вероятности исхода;
 * lichess-формула — внешняя сигмоида над cp с эмпирически подобранными
 * коэффициентами и иной кривой насыщения.
 *
 * Общие WDL-утилиты (`Wdl`, `wdlSigned`, `wdlSignedFromInfo`) живут в
 * `@kingside/shared/utils/wdl` (KS-2583) — реэкспорт ниже. Это нужно
 * чтобы клиентский генератор пазлов (KS-2584) использовал тот же
 * алгоритм без копипаста.
 *
 * cp/mate helpers и `wdlFromSide` остаются здесь: они нужны только
 * серверному tagging-pipeline (`tagging.ts`).
 */
import type { ScoreCp } from '../stockfish/stockfish.service';
import { wdlSigned } from '@kingside/shared';

// Реэкспорт shared-утилит — внешние импортёры этого файла не ломаются.
export { wdlSigned, wdlSignedFromInfo, type Wdl } from '@kingside/shared';

/**
 * WDL_signed от лица заданной стороны.
 * `wdl` — POV side-to-move (как Stockfish отдаёт). Если asSide совпадает
 * с side-to-move в той позиции — отдаём как есть. Иначе инвертируем.
 */
export function wdlFromSide(
  wdl: { w: number; d: number; l: number },
  asSide: 'w' | 'b',
  sideToMove: 'w' | 'b',
): number {
  const signed = wdlSigned(wdl);
  return asSide === sideToMove ? signed : -signed;
}

/* ─── cp helpers (для tagging crushing/advantage) ─────────────── */

const MATE_CP_BASE = 100_000;

/** cp от лица side; mate → ±(100000 - distance). */
export function cpFromSide(
  score: ScoreCp,
  asSide: 'w' | 'b',
  sideToMove: 'w' | 'b',
): number {
  let cp: number;
  if (score.type === 'cp') {
    cp = score.value;
  } else {
    const sign = score.value >= 0 ? 1 : -1;
    cp = sign * (MATE_CP_BASE - Math.abs(score.value));
  }
  return asSide === sideToMove ? cp : -cp;
}

export function isMateScore(score: ScoreCp): boolean {
  return score.type === 'mate';
}

export function isMateForSideToMove(score: ScoreCp): boolean {
  return score.type === 'mate' && score.value > 0;
}
