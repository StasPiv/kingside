/**
 * KS-3136 / ADR-068 §3.2, §6 — единая (server+client) реализация
 * алгоритма «зевок» puzzle-генератора.
 *
 * До этой задачи логика существовала параллельно в двух местах
 * (`apps/tactic-worker/.../generator-pipeline.ts` и
 * `apps/web/src/utils/puzzleGenerator.ts`). Здесь — единственный
 * источник истины: дельты вычисляются один раз, по одним и тем же
 * формулам, обе обёртки только передают свои настройки и реагируют
 * на результат.
 *
 * Скоуп функции — узкий и чистый:
 *   - вход: два WDL POV (до/после хода) — `wdlBeforeRaw` POV блaндера,
 *     `wdlAfterRaw` POV решающего;
 *   - выход: «принято» с дельтами и причиной триггера ИЛИ «отклонено»
 *     с конкретным reason'ом для drop-метрики.
 *
 * Вне scope:
 *   - `samePv1` / `skipDecided` / `gameOver` / `noScore` фильтры — это
 *     pre-conditions, проверяются до вызова и в обёртке-собственно
 *     становятся отдельными drop-кейсами;
 *   - solvability-check после accept — отдельный этап у tactic-worker'а,
 *     к данному модулю отношения не имеет.
 */
import { deltaDFromWdl, deltaWFromWdl, type Wdl } from './wdl.js';

/**
 * Источник данных от Stockfish. Оба объекта — per-mille (0..1000),
 * POV side-to-move в той позиции, где их вернул движок:
 *   - `wdlBeforeRaw` — на fenBefore (side-to-move = блaндер);
 *   - `wdlAfterRaw`  — на fenAfter (side-to-move = решающий, т.е.
 *     POV-противоположен блaндеру).
 */
export interface BlunderEvalInput {
  wdlBeforeRaw: Wdl;
  wdlAfterRaw: Wdl;
}

/**
 * Настройки порогов и after-фильтра. На сервере — hardcoded константы
 * (`apps/tactic-worker`), на клиенте — пользовательский control
 * (`PuzzleGeneratorModal`). См. ADR-068 §1.2 и KS-3140 (объединённый
 * after-фильтр).
 */
export interface BlunderEvalSettings {
  /** Порог `deltaW` для триггера по падению P(победа). Default 0.6. */
  deltaWThreshold: number;
  /** Порог `deltaD` для триггера по падению P(ничья). Default 0.6. */
  deltaDThreshold: number;
  /**
   * KS-3140: единый after-фильтр. Минимальная сумма `W + D` решающего
   * сразу после хода. Покрывает оба сценария «реализуй перевес»
   * (`W_after ≥ 0.5`) и «спасение в ничью» (`D_after ≥ 0.5` при
   * `W_after ≈ 0`). Default 0.5.
   *
   * KS-3140 / ADR-068 §3.2 (rev2): прежний `minWAfterForSolver`
   * удалён — раздельные W-/D-фильтры через `if/else if` отсекали
   * пазлы «триггер по W + solver получает ничью» (W_after мал, D_after
   * велик). Объединённый фильтр W+D ≥ X пропускает их.
   */
  minWPlusDAfterForSolver: number;
}

/**
 * Какая(ие) дельта(ы) пробила порог:
 *   - `'W'`  — только `deltaW ≥ deltaWThreshold`;
 *   - `'D'`  — только `deltaD ≥ deltaDThreshold`;
 *   - `'WD'` — обе дельты ≥ своих порогов одновременно.
 */
export type BlunderTrigger = 'W' | 'D' | 'WD';

/**
 * Причины отклонения:
 *   - `notBlunder`     — обе дельты ниже порогов;
 *   - `lowWplusDAfter` — KS-3140: единый after-фильтр W+D ≥ X не прошёл,
 *     решающий после хода не выигрывает И не держит ничью (позиция
 *     проигрышная для solver'а).
 */
export type BlunderRejectReason = 'notBlunder' | 'lowWplusDAfter';

export type BlunderEvalResult =
  | {
      kind: 'blunder';
      trigger: BlunderTrigger;
      deltaW: number;
      deltaD: number;
    }
  | {
      kind: 'rejected';
      reason: BlunderRejectReason;
      deltaW: number;
      deltaD: number;
    };

/**
 * Чистая (no I/O, deterministic) оценка одного хода как «зевок».
 *
 * Алгоритм (ADR-068 §3.2, rev2 — KS-3140):
 *
 * 1. `deltaW = (before.w − after.l) / 1000`. POV-инверсия после хода
 *    учтена: L_after (POV решающего) = W_after (POV блaндера), их
 *    разница с before.w даёт «насколько упала вероятность победы
 *    блaндера».
 * 2. `deltaD = (before.d − after.d) / 1000`. Draw симметричен при
 *    смене стороны, инверсия не нужна.
 * 3. Триггер OR: `deltaW ≥ thrW` ИЛИ `deltaD ≥ thrD`. Если ни одно
 *    не выполнено — `rejected/notBlunder`.
 * 4. KS-3140: единый after-фильтр для обоих триггеров:
 *    `W_after_for_solver + D_after_for_solver ≥ minWPlusDAfterForSolver`.
 *    Покрывает «реализуй перевес» (W_after велик), «спасение в ничью»
 *    (D_after велик), смешанные сценарии. Прежний `if/else if`
 *    раздельный W-/D-фильтр в редакции KS-3136 отсекал реальный жанр
 *    «триггер по W + solver попадает в ничью» (W_after низкий,
 *    D_after высокий) — таких пазлов теряли целый класс (см. диагностику
 *    KS-3139 / 39. d6).
 *
 *    POV-замечание: `afterRaw` — POV side-to-move на `fenAfter`, т.е.
 *    POV решающего (солвера). Поэтому `afterRaw.w` это W_solver,
 *    `afterRaw.d` — D_solver (draw симметричен), сумма W+D даёт
 *    «вероятность что solver хотя бы не проиграет».
 *
 * Возвращает `deltaW`/`deltaD` всегда (и в `blunder`, и в `rejected`)
 * — обёртка может использовать их для metadata и drop-логирования.
 */
export function evaluateBlunder(
  input: BlunderEvalInput,
  settings: BlunderEvalSettings,
): BlunderEvalResult {
  const { wdlBeforeRaw: before, wdlAfterRaw: afterRaw } = input;

  const deltaW = deltaWFromWdl(before, afterRaw);
  const deltaD = deltaDFromWdl(before, afterRaw);

  const triggerByW = deltaW >= settings.deltaWThreshold;
  const triggerByD = deltaD >= settings.deltaDThreshold;

  if (!triggerByW && !triggerByD) {
    return { kind: 'rejected', reason: 'notBlunder', deltaW, deltaD };
  }

  // KS-3140: единый after-фильтр. afterRaw POV solver, поэтому
  // afterRaw.w == W_solver, afterRaw.d == D_solver.
  const wAfterForSolver = afterRaw.w / 1000;
  const dAfterForSolver = afterRaw.d / 1000;
  if (
    wAfterForSolver + dAfterForSolver <
    settings.minWPlusDAfterForSolver
  ) {
    return { kind: 'rejected', reason: 'lowWplusDAfter', deltaW, deltaD };
  }

  const trigger: BlunderTrigger =
    triggerByW && triggerByD ? 'WD' : triggerByW ? 'W' : 'D';
  return { kind: 'blunder', trigger, deltaW, deltaD };
}

/**
 * KS-3144 / ADR-069 — жанр пазла для UI/телеметрии. Различает «реализуй
 * перевес» и «спасение в ничью», глядя на WDL решающего сразу после
 * хода блaндера.
 *
 *   - `convertAdvantage` — solver получил выигрышную позицию
 *     (`W_after_for_solver ≥ 0.5`). В UI можно подсветить «реализуй
 *     перевес», цель — добить.
 *   - `saveEquality` — solver не в выигрыше, но шансы на ничью
 *     достаточные (after-фильтр `W + D ≥ 0.5` обеспечивает что
 *     позиция как минимум держится). Цель — удержать ничью.
 *
 * Жанр определяется единственным числом — `wdl_after_raw.w`, потому
 * что на fenAfter side-to-move = решающий и `afterRaw.w = W_solver`.
 * Поэтому функции достаточно одного аргумента `wdlAfterRaw`.
 */
export type PuzzleObjective = 'convertAdvantage' | 'saveEquality';

export function determinePuzzleObjective(wdlAfterRaw: Wdl): PuzzleObjective {
  return wdlAfterRaw.w / 1000 >= 0.5 ? 'convertAdvantage' : 'saveEquality';
}
