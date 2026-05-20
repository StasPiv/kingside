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
 * Настройки порогов и after-фильтров. На сервере — hardcoded константы
 * (`apps/tactic-worker`), на клиенте — пользовательский control
 * (`PuzzleGeneratorModal`). См. ADR-068 §1.2.
 */
export interface BlunderEvalSettings {
  /** Порог `deltaW` для триггера по падению P(победа). Default 0.6. */
  deltaWThreshold: number;
  /** Порог `deltaD` для триггера по падению P(ничья). Default 0.6. */
  deltaDThreshold: number;
  /**
   * Минимальный `W_after_for_solver` (вероятность победы решающего
   * сразу после хода) при триггере по W. Если ниже — «шанс на победу»
   * — мираж, drop. Default 0.5.
   */
  minWAfterForSolver: number;
  /**
   * Минимальная сумма `W + D` решающего сразу после хода при триггере
   * по D без W. Решающий должен хотя бы «держать ничью», иначе позиция
   * проигрышная — drop. Default 0.5.
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
 * Причины отклонения. `lowWAfterForSolver` — триггер по W прошёл, но
 * `W_after_for_solver < minWAfterForSolver` (мираж). `lowWplusDAfter` —
 * триггер по D (без W) прошёл, но `W + D < minWPlusDAfterForSolver`
 * (решающий не держит даже ничью). `notBlunder` — обе дельты ниже
 * порогов.
 */
export type BlunderRejectReason =
  | 'notBlunder'
  | 'lowWAfterForSolver'
  | 'lowWplusDAfter';

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
 * Алгоритм (ADR-068 §3.2):
 *
 * 1. `deltaW = (before.w − after.l) / 1000`. POV-инверсия после хода
 *    учтена: L_after (POV решающего) = W_after (POV блaндера), их
 *    разница с before.w даёт «насколько упала вероятность победы
 *    блaндера».
 * 2. `deltaD = (before.d − after.d) / 1000`. Draw симметричен при
 *    смене стороны, инверсия не нужна.
 * 3. Триггер OR: `deltaW ≥ thrW` ИЛИ `deltaD ≥ thrD`. Если ни одно
 *    не выполнено — `rejected/notBlunder`.
 * 4. After-фильтры (POV решающего, как Stockfish отдал на fenAfter):
 *    - триггер по W → `W_after_for_solver = afterRaw.w / 1000` должен
 *      быть ≥ `minWAfterForSolver`. Защита от «мираж-побед» (W упал у
 *      блaндера, но и решающий в выигранной позиции не оказался).
 *    - триггер только по D (без W) → `W_after_for_solver +
 *      D_after_for_solver ≥ minWPlusDAfterForSolver`. Защита от
 *      «упустил ничью в проигранной позиции».
 *    Когда оба триггера сработали одновременно — проверяется только
 *    W-фильтр (более строгий и семантически правильный: «пазл на
 *    реализацию преимущества»).
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

  const wAfterForSolver = afterRaw.w / 1000;
  const dAfterForSolver = afterRaw.d / 1000;

  if (triggerByW) {
    if (wAfterForSolver < settings.minWAfterForSolver) {
      return {
        kind: 'rejected',
        reason: 'lowWAfterForSolver',
        deltaW,
        deltaD,
      };
    }
  } else if (triggerByD) {
    // Триггер только по D — нужен мягкий after-фильтр «хотя бы ничья».
    if (
      wAfterForSolver + dAfterForSolver <
      settings.minWPlusDAfterForSolver
    ) {
      return {
        kind: 'rejected',
        reason: 'lowWplusDAfter',
        deltaW,
        deltaD,
      };
    }
  }

  const trigger: BlunderTrigger =
    triggerByW && triggerByD ? 'WD' : triggerByW ? 'W' : 'D';
  return { kind: 'blunder', trigger, deltaW, deltaD };
}
