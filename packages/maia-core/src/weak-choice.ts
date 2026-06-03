/**
 * KS-3640 / ADR-106 §2.1 (Precision-Maia v2). Pure-вычисление новой
 * метрики `maiaWeakChoiceProb` — суммарная вероятность Maia сыграть
 * один из «слабых» ходов (по `loss_E > 0.02` относительно лучшего
 * хода из множества `{firstMovePV1} ∪ MaiaTopK`).
 *
 * Заменяет отменённую top-1 метрику (ADR-104). Алгоритм:
 *
 *   1. `maiaTopK = { m | policy[m] > 0.10 } ∩ топ-K_max`, где
 *      `K_max = 8`. Динамический K через порог policy — естественно
 *      фокусируется на реалистично играемых ходах (см. ADR-106 §2.2).
 *   2. `searchmoves = unique([firstMovePV1, ...maiaTopK])`.
 *      Опорная точка — solver-best (firstMovePV1) из
 *      `Puzzle.sourceMetadata`, чтобы granica «слабого» не зависела
 *      от того, попал ли solver-best в Maia top-K (часто не попадает
 *      на нетипичных тактиках).
 *   3. `bestE = max(expectedScoreFromWdl(wdl_i))` среди searchmoves.
 *   4. `weak_set = { m ∈ maiaTopK | bestE − expectedScoreFromWdl(wdl_m)
 *                                   > 0.02 }`.
 *   5. `maiaWeakChoiceProb = Σ policy[m]` для m ∈ weak_set.
 *
 * Порог `loss_E > 0.02` совпадает с границей `best` по ADR-066:
 * ход с loss_E ≤ 0.02 считается равно-сильным и не входит в weak_set.
 *
 * Pure-функция: ни SF, ни Maia engine не дёргает. Caller обязан:
 *  - получить `policy` через `Maia.predictMoves(fen, elo, elo)` и
 *  - получить `expectedScores` через
 *    `StockfishService.analyzePositionWdl(fen, limit, searchmoves.length,
 *     label, undefined, searchmoves)` плюс
 *    `expectedScoreFromWdl` из `@kingside/shared/utils/wdl` (или
 *    inline `(w + d/2)/1000` для WDL per-mille POV side-to-move).
 *
 * Возвращаемая структура содержит не только финальный `weakChoiceProb`,
 * но и промежуточные `maiaTopK` / `weakSet` — нужны для отладки и
 * report'а CLI (см. T1, KS-3641).
 */

/**
 * Версия алгоритма для записи в `Puzzle.maiaMetricVersion`.
 * Инкрементировать при любой смене формулы: `MAIA_TOP_K_MAX`,
 * `MAIA_TOP_K_POLICY_THRESHOLD`, `WEAK_LOSS_E_THRESHOLD`, либо
 * структурной (другой источник searchmoves, другая агрегация).
 *
 * При смене значения старые записи остаются с предыдущей версией;
 * фронт сравнивает с актуальной константой и фильтрует только
 * «свежие» строки (см. ADR-106 §5).
 */
export const MAIA_WEAK_CHOICE_METRIC_VERSION = 1;

/** Maia policy-порог для попадания хода в MaiaTopK. ADR-106 §2.1 пункт 2. */
export const MAIA_TOP_K_POLICY_THRESHOLD = 0.1;

/** Верхняя граница размера MaiaTopK (после policy-фильтра). ADR-106 §2.1. */
export const MAIA_TOP_K_MAX = 8;

/** Граница «слабого» хода по loss_E. ADR-106 §2.1 + ADR-066 §best. */
export const WEAK_LOSS_E_THRESHOLD = 0.02;

/**
 * Минимальный shape MovePrediction из `engine.ts` — переобъявлен здесь
 * чтобы pure-модуль не зависел от Maia-инфера и был импортируемым
 * без onnxruntime в caller'е (admin-CLI, юнит-тесты).
 */
export interface PolicyEntry {
  move: string;
  probability: number;
}

export interface WeakChoiceInput {
  /**
   * Полное распределение Maia по легальным ходам. Не обязательно
   * отсортировано — функция сама делает stable-sort по убыванию
   * `probability` перед фильтром top-K.
   */
  policy: ReadonlyArray<PolicyEntry>;
  /**
   * Эталонный «лучший» ход solver'а из `Puzzle.sourceMetadata.firstMovePV1`.
   * Включается в `searchmoves` даже если не входит в MaiaTopK —
   * гарантирует, что `bestE` всегда ≥ ожидаемой оценки правильного
   * хода.
   */
  firstMovePV1: string;
  /**
   * Expected-score (≈ win-probability) каждого UCI-хода из
   * `searchmoves`. Шкала 0..1 (`(W + D/2) / 1000` для per-mille WDL
   * POV side-to-move; см. `@kingside/shared/utils/wdl.expectedScoreFromWdl`).
   *
   * Ходы, отсутствующие в Map (caller не получил wdl или SF не
   * вернул линию), считаются «нет данных» и не участвуют в выборе
   * `bestE` / `weak_set`. Если Map пуст или ни один searchmove не
   * имеет данных — `weakChoiceProb = 0` + `bestExpectedScore = 0`
   * (caller обычно трактует как «разметка не получилась», но
   * технически функция возвращает корректный «пустой» результат).
   */
  expectedScores: ReadonlyMap<string, number>;
}

export interface WeakSetEntry {
  move: string;
  /** policy-вероятность хода по Maia (та же что в input.policy). */
  policy: number;
  /** Потеря в expected-score относительно best: `bestE − E(move)`. */
  lossE: number;
}

export interface WeakChoiceResult {
  /**
   * `Σ policy[m]` для слабых m. 0..1. Это значение и идёт в БД
   * как `puzzles.maia_weak_choice_prob`. Если weak_set пустой — 0.
   */
  weakChoiceProb: number;
  /**
   * UCI-ходы, попавшие в `maiaTopK` (после policy-фильтра, до K_max).
   * Не включает firstMovePV1 если его policy-вероятность ≤ порога.
   */
  maiaTopK: string[];
  /**
   * Финальный список ходов, переданных SF в searchmoves
   * (`unique([firstMovePV1, ...maiaTopK])`). Caller использует для
   * запроса `analyzePositionWdl(..., searchMoves)`. Возвращается в
   * порядке: firstMovePV1 первый, потом MaiaTopK по убыванию policy.
   */
  searchMoves: string[];
  /** Best expected-score среди searchmoves (0..1). */
  bestExpectedScore: number;
  /** Слабые ходы из MaiaTopK с метаданными (для лога/report). */
  weakSet: WeakSetEntry[];
}

/**
 * Шаг 1-2 из ADR-106 §2.1: построить список ходов для запроса SF.
 * Выделено отдельно, чтобы caller мог использовать список напрямую
 * в `analyzePositionWdl(..., searchMoves)` без вычисления weak-set
 * (промежуточный шаг).
 */
export function buildMaiaSearchMoves(
  policy: ReadonlyArray<PolicyEntry>,
  firstMovePV1: string,
): { maiaTopK: string[]; searchMoves: string[] } {
  const sorted = [...policy].sort((a, b) => b.probability - a.probability);
  const maiaTopK: string[] = [];
  for (const entry of sorted) {
    if (entry.probability <= MAIA_TOP_K_POLICY_THRESHOLD) break;
    maiaTopK.push(entry.move);
    if (maiaTopK.length >= MAIA_TOP_K_MAX) break;
  }
  const searchMovesSet = new Set<string>();
  // firstMovePV1 первым — даёт caller'у понять, какой ход «опорный»,
  // и сохраняет порядок при дальнейшем дебаге.
  if (firstMovePV1) searchMovesSet.add(firstMovePV1);
  for (const m of maiaTopK) searchMovesSet.add(m);
  return { maiaTopK, searchMoves: Array.from(searchMovesSet) };
}

/**
 * Полный вычислитель `maiaWeakChoiceProb` по ADR-106 §2.1.
 *
 * Граничные случаи:
 *  - `policy` пустая → MaiaTopK пустой, searchMoves = [firstMovePV1]
 *    (если задан) → weak_set пустой → `weakChoiceProb = 0`. Это
 *    штатное поведение для позиций, где Maia ничего не предложила
 *    (теоретически невозможно при ≥1 легальном ходе, но safe).
 *  - `expectedScores` не содержит ни одного searchmove → `bestE = 0`,
 *    weak_set пустой → `weakChoiceProb = 0`. Caller-ответственность
 *    залогировать «нет SF-данных» отдельно.
 *  - Один сильный ход и MaiaTopK не содержит других кандидатов →
 *    weak_set пустой → `weakChoiceProb = 0` (позиция «однозначная»).
 *  - Несколько равно-сильных в MaiaTopK (все с loss_E ≤ 0.02) →
 *    weak_set пустой → `weakChoiceProb = 0`.
 */
export function computeWeakChoiceProb(
  input: WeakChoiceInput,
): WeakChoiceResult {
  const { maiaTopK, searchMoves } = buildMaiaSearchMoves(
    input.policy,
    input.firstMovePV1,
  );

  let bestE = -Infinity;
  for (const m of searchMoves) {
    const e = input.expectedScores.get(m);
    if (e !== undefined && e > bestE) bestE = e;
  }
  if (bestE === -Infinity) {
    return {
      weakChoiceProb: 0,
      maiaTopK,
      searchMoves,
      bestExpectedScore: 0,
      weakSet: [],
    };
  }

  // Быстрый lookup policy по uci для расчёта весов в weak_set
  // (input.policy может быть не отсортирована).
  const policyByMove = new Map<string, number>();
  for (const p of input.policy) policyByMove.set(p.move, p.probability);

  const weakSet: WeakSetEntry[] = [];
  for (const move of maiaTopK) {
    const e = input.expectedScores.get(move);
    if (e === undefined) continue;
    const lossE = bestE - e;
    if (lossE > WEAK_LOSS_E_THRESHOLD) {
      weakSet.push({
        move,
        policy: policyByMove.get(move) ?? 0,
        lossE,
      });
    }
  }

  const weakChoiceProb = weakSet.reduce((acc, w) => acc + w.policy, 0);

  return {
    weakChoiceProb,
    maiaTopK,
    searchMoves,
    bestExpectedScore: bestE,
    weakSet,
  };
}
