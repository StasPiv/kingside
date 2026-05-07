/**
 * KS-2431 (WDL pivot) → KS-2583 (вынос в shared).
 *
 * Shared-утилиты для работы со Stockfish WDL и cp/mate. Используются
 * серверным `tactic-worker` и (в перспективе KS-2584) клиентским
 * генератором пазлов — общий алгоритм без копипаста.
 *
 * Принципы:
 *   - WDL_signed = (W − L) / 1000, диапазон [-1..+1] от лица side-to-move.
 *   - При сравнении до/после хода учитывается смена стороны: для оценки
 *     «насколько ход ухудшил позицию для сходившего» инвертируем WDL
 *     после хода (новая сторона на ходу — противник сходившего).
 *   - Mate-оценки: если Stockfish не отдал WDL (старые версии при mate),
 *     берём ±1 как заглушку (mate в нашу пользу = +1, против = −1).
 *
 * Note: cp-helpers (`cpFromSide`, `MATE_CP_BASE`, `isMateScore`,
 * `isMateForSideToMove`, `wdlFromSide`) остаются в
 * `apps/tactic-worker/src/puzzle-generator/score.ts` — они нужны только
 * серверному tagging-pipeline, в shared не выносим.
 */

/**
 * Per-mille WDL (0..1000), POV side-to-move. Формат, в котором
 * Stockfish с включённой опцией `UCI_ShowWDL` отдаёт распределение
 * исходов. Сумма (w + d + l) ≈ 1000 (округление допускает ±1).
 */
export interface Wdl {
  w: number;
  d: number;
  l: number;
}

/**
 * Минимальная форма Stockfish-score, нужная `wdlSignedFromInfo` для
 * mate-fallback. Совместима с серверным `ScoreCp` (apps/tactic-worker)
 * и любым другим источником, который возвращает дискриминированный
 * union по `type`.
 */
export interface WdlScoreInfo {
  type: 'cp' | 'mate';
  value: number;
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
  score: WdlScoreInfo,
): number | null {
  if (wdl) return wdlSigned(wdl);
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  return null;
}
