/**
 * KS-2431 (WDL pivot). Helpers для работы со Stockfish WDL и cp/mate.
 *
 * Pipeline puzzle-generator переведён на источник «выигрышные шансы»
 * из UCI_ShowWDL (per-mille W/D/L), а не на cp-сигмоиду lichess.
 * Причина: Stockfish WDL — нативная NNUE-оценка вероятности исхода;
 * lichess-формула — внешняя сигмоида над cp с эмпирически подобранными
 * коэффициентами и иной кривой насыщения.
 *
 * Принципы:
 *   - WDL_signed = (W − L) / 1000, диапазон [-1..+1] от лица side-to-move.
 *   - При сравнении до/после хода учитываем смену стороны: для оценки
 *     «насколько ход ухудшил позицию для сходившего» инвертируем WDL
 *     после хода (новая сторона на ходу — противник сходившего).
 *   - Mate-оценки: если Stockfish не отдал WDL (старые версии при mate),
 *     берём ±1 как заглушку (mate в нашу пользу = +1, против = −1).
 *
 * cp/mate helpers из исходной версии остаются: `cpFromSide` ещё нужен
 * для tagging.ts (порог crushing/advantage).
 */
import type { ScoreCp } from '../stockfish/stockfish.service';

export interface Wdl {
  /** per-mille (0..1000), POV side-to-move. */
  w: number;
  d: number;
  l: number;
}

/**
 * Знаковая шкала WDL [-1..+1] от лица side-to-move.
 * `(W − L) / 1000`. +1 = гарантированная победа, -1 = гарантированный
 * проигрыш, 0 = ничья.
 */
export function wdlSigned(wdl: Wdl): number {
  return (wdl.w - wdl.l) / 1000;
}

/**
 * Извлечь WDL_signed из Stockfish-инфо. Если WDL отсутствует (опция
 * выключена или mate без WDL у некоторых версий), используем
 * fallback по score:
 *   - mate в пользу sideToMove → +1
 *   - mate против sideToMove → -1
 *   - cp без WDL → null (caller обязан учесть и не использовать в
 *     арифметике; но обычно WDL всегда есть когда опция включена).
 */
export function wdlSignedFromInfo(
  wdl: Wdl | null | undefined,
  score: ScoreCp,
): number | null {
  if (wdl) return wdlSigned(wdl);
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  return null;
}

/**
 * WDL_signed от лица заданной стороны.
 * `wdl` — POV side-to-move (как Stockfish отдаёт). Если asSide совпадает
 * с side-to-move в той позиции — отдаём как есть. Иначе инвертируем.
 */
export function wdlFromSide(
  wdl: Wdl,
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
