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
 * KS-3386 / ADR-083 §3.1. POV-зеркало WDL при смене стороны на ходу.
 * Вероятность выигрыша одной стороны == вероятность проигрыша другой,
 * ничья симметрична: `{w, d, l}` → `{w: l, d, l: w}`.
 *
 * Используется для POV-нормализации eval-кривой screen-фазы: Stockfish
 * отдаёт WDL POV side-to-move, а нам нужна единая база (POV white) или
 * приведение к POV конкретного игрока.
 */
export function invertWdl(wdl: Wdl): Wdl {
  return { w: wdl.l, d: wdl.d, l: wdl.w };
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

/**
 * KS-3135 / ADR-068 §2.3. Извлечь `Wdl` объект из Stockfish-инфо с
 * mate-fallback. Когда WDL отсутствует (старые версии при mate-оценке),
 * собираем per-mille заглушку POV side-to-move:
 *   - mate в пользу sideToMove → `{w: 1000, d: 0, l: 0}`
 *   - mate против sideToMove → `{w: 0, d: 0, l: 1000}`
 *   - cp без WDL → `null` (caller должен учесть и не считать дельты).
 *
 * В отличие от `wdlSignedFromInfo`, которая возвращает signed-скаляр,
 * эта функция нужна `deltaWFromWdl` / `deltaDFromWdl` — им требуются
 * полные {w,d,l}-объекты, а не свёртка.
 */
export function wdlOrMateFallback(
  wdl: Wdl | null | undefined,
  score: WdlScoreInfo,
): Wdl | null {
  if (wdl) return wdl;
  if (score.type === 'mate') {
    return score.value > 0
      ? { w: 1000, d: 0, l: 0 }
      : { w: 0, d: 0, l: 1000 };
  }
  return null;
}

/**
 * KS-3135 / ADR-068 §2.4. Δ-падение вероятности победы блaндера на ходе.
 *
 *   deltaW = (W_до − L_после_raw) / 1000
 *
 * Учитывает POV-инверсию после хода: на `fenAfter` side-to-move = соперник
 * блaндера, поэтому L_решающего_после == W_блaндера_после (зеркало WDL
 * при смене стороны). Возвращает Δ ∈ [−1..+1]; **положительное = вероятность
 * победы блaндера упала**, что и нужно как триггер пазла.
 *
 * `before` — `Wdl` POV блaндера на fenBefore (как отдал Stockfish для
 * fenBefore с side-to-move = блaндер).
 * `afterRaw` — `Wdl` POV решающего на fenAfter (как отдал Stockfish для
 * fenAfter с side-to-move = решающий).
 */
export function deltaWFromWdl(before: Wdl, afterRaw: Wdl): number {
  return (before.w - afterRaw.l) / 1000;
}

/**
 * KS-3135 / ADR-068 §2.4. Δ-падение вероятности ничьи блaндера на ходе.
 *
 *   deltaD = (D_до − D_после) / 1000
 *
 * Draw-вероятность симметрична при смене стороны (D_решающего_после ==
 * D_блaндера_после), поэтому POV-инверсия не нужна — `D_after_raw`
 * равен `D_after_pov_blunder`. Возвращает Δ ∈ [−1..+1]; **положительное =
 * вероятность ничьи упала**.
 */
export function deltaDFromWdl(before: Wdl, afterRaw: Wdl): number {
  return (before.d - afterRaw.d) / 1000;
}
