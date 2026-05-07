/**
 * KS-2583 (ADR-050 §3 #4). Дефолты puzzle-генератора, общие для
 * серверного `tactic-worker` и клиентского генератора (KS-2584).
 *
 * Подмножество `defaultGeneratorOptions` из
 * `apps/tactic-worker/src/puzzle-generator/types.ts`. Сюда вынесены
 * только параметры **алгоритма обнаружения пазлов** — пороги WDL,
 * длина анализа после блaндера, минимальный ply начала анализа.
 *
 * НЕ выносятся (остаются серверными):
 *   - `maxGames`, `gameBatchSize`, `cursor` — параметры обхода БД
 *   - `engineLimit` — серверная Stockfish-конфигурация
 *   - `solutionMode` — стратегия выбора solution path (server-only)
 *   - legacy forced-line поля (`spreadDelta`, `continueSpreadDelta`,
 *     `forcedSpreadDelta`, `minRating`, `minPly`, `minLineLength`,
 *     `maxLineLength`) — нужны только CLI-режиму tactic-worker
 *
 * Семантика полей — в JSDoc'ах ниже и в ADR-044/050.
 */
export const PUZZLE_GEN_DEFAULTS = {
  /**
   * X в формуле WDL_after − WDL_before ≤ −X. Lichess-уровень X=0.6
   * (ADR-044 §2.1, сравнительный анализ с lichess-puzzler).
   */
  blunderDelta: 0.6,
  /**
   * Глубина анализа решения (полуходов после блaндера). По умолчанию 6
   * — типичная длина тактической комбинации.
   */
  halfMovesN: 6,
  /**
   * Минимальный WDL_signed после правильного хода соперника, чтобы
   * считать пазл «решённым» (победа достигнута).
   */
  winThreshold: 0.5,
  /**
   * Максимальный WDL_signed после ошибочного хода соперника, чтобы
   * считать пазл «не решённым» (порог сваливания).
   */
  failThreshold: 0.0,
  /**
   * Если |WDL_signed| ≥ skipDecidedWdl уже до блaндера — пропускаем
   * позицию (партия уже решена, новый блaндер тактически не интересен).
   */
  skipDecidedWdl: 0.95,
  /**
   * Минимальный WDL_signed для side, **получившего шанс** после
   * блaндера. Защита от пазлов, где «шанс» — мираж (соперник всё ещё
   * сильно проигрывает после блaндера).
   */
  minWdlAfterBlunder: 0.5,
  /**
   * Стартовый ply анализа партии. Раньше — дебютная теория (cp ≠
   * объективная оценка), пазлы не ищем.
   */
  startPly: 20,
} as const;

export type PuzzleGenDefaults = typeof PUZZLE_GEN_DEFAULTS;
