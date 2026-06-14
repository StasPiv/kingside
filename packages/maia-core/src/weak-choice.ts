/**
 * KS-3640 / ADR-106 §2.1 (Precision-Maia v2) + KS-4107 (soft-threshold v2).
 * Pure-вычисление метрики `maiaWeakChoiceProb` — суммарная «взвешенная»
 * вероятность Maia сыграть «слабый» ход. Версия 2 формулы (KS-4107):
 * вместо ступенчатой границы `loss_E > 0.02` используется непрерывная
 * функция веса `weakWeight(loss_E)`, чтобы тысячные WDL не флипали
 * классификацию хода (расхождение SF18 WASM ↔ SF15.1 native на
 * пограничных позициях, см. KS-4100/QA).
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
 *   4. Для каждого `m ∈ maiaTopK`: `loss_E = bestE − E(m)`,
 *      `w(m) = clamp((loss_E − (center − width/2)) / width, 0, 1)`.
 *      Центр `WEAK_LOSS_E_CENTER = 0.02`, ширина переходной зоны
 *      `WEAK_LOSS_E_SOFT_WIDTH = 0.01`. На границах:
 *        - `loss_E ≤ 0.015` → w = 0 (точно сильный);
 *        - `loss_E ≥ 0.025` → w = 1 (точно слабый);
 *        - `loss_E = 0.020` → w = 0.5 (граница).
 *   5. `maiaWeakChoiceProb = Σ policy[m] · w(m)` для m ∈ maiaTopK.
 *
 * Центр 0.02 совпадает с границей `best` по ADR-066. Линейный переход
 * на интервале 0.01 (≈±5 cp в WDL-эквиваленте) делает метрику
 * устойчивой к расхождению версий движков и недетерминизму SF на тихих
 * позициях. Параметры центра/ширины — настраиваемые через
 * `WeakChoiceInput` (полезно для A/B-тестов калибровки).
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
 * `MAIA_TOP_K_POLICY_THRESHOLD`, `WEAK_LOSS_E_CENTER`,
 * `WEAK_LOSS_E_SOFT_WIDTH`, либо структурной (другой источник
 * searchmoves, другая агрегация).
 *
 * При смене значения старые записи остаются с предыдущей версией;
 * фронт сравнивает с актуальной константой и фильтрует только
 * «свежие» строки (см. ADR-106 §5).
 *
 * Версии:
 *  - 1 — ADR-106 §2.1. Ступенчатая граница `loss_E > 0.02`.
 *  - 2 — KS-4107. Soft-threshold (непрерывный линейный переход на
 *        интервале `[center − width/2, center + width/2]`).
 */
export const MAIA_WEAK_CHOICE_METRIC_VERSION = 2;

/** Maia policy-порог для попадания хода в MaiaTopK. ADR-106 §2.1 пункт 2. */
export const MAIA_TOP_K_POLICY_THRESHOLD = 0.1;

/** Верхняя граница размера MaiaTopK (после policy-фильтра). ADR-106 §2.1. */
export const MAIA_TOP_K_MAX = 8;

/**
 * Центр переходной зоны «слабого» хода по loss_E. ADR-106 §2.1 +
 * ADR-066 §best. На loss_E = `WEAK_LOSS_E_CENTER` вес = 0.5.
 */
export const WEAK_LOSS_E_CENTER = 0.02;

/**
 * Полная ширина переходной зоны soft-threshold (KS-4107). На интервале
 * `[center − width/2, center + width/2]` вес меняется линейно от 0 до
 * 1. За пределами интервала — насыщение (0 слева, 1 справа). Ширина
 * 0.01 ≈ ±5 cp в WDL-эквиваленте — поглощает тысячные WDL расхождения
 * между версиями Stockfish и недетерминизм многопоточного поиска.
 */
export const WEAK_LOSS_E_SOFT_WIDTH = 0.01;

/**
 * @deprecated Алиас `WEAK_LOSS_E_CENTER` для совместимости с metric_version=1.
 * Использовать `WEAK_LOSS_E_CENTER` и `WEAK_LOSS_E_SOFT_WIDTH`.
 */
export const WEAK_LOSS_E_THRESHOLD = WEAK_LOSS_E_CENTER;

/**
 * Линейный soft-threshold веса «слабого» хода (KS-4107). Возвращает
 * 0..1: 0 — точно сильный (`loss_E ≤ center − width/2`), 1 — точно
 * слабый (`loss_E ≥ center + width/2`), линейно между.
 *
 * Pure-функция, без побочных эффектов. Параметры по умолчанию —
 * `WEAK_LOSS_E_CENTER` / `WEAK_LOSS_E_SOFT_WIDTH`; caller может
 * переопределить (A/B калибровка, тесты).
 */
export function weakWeight(
  lossE: number,
  center: number = WEAK_LOSS_E_CENTER,
  width: number = WEAK_LOSS_E_SOFT_WIDTH,
): number {
  if (width <= 0) {
    // Деградация в ступеньку (на случай явного отключения soft-threshold).
    return lossE > center ? 1 : 0;
  }
  const lower = center - width / 2;
  const t = (lossE - lower) / width;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

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
  /**
   * (KS-4107) Опциональное переопределение центра soft-threshold
   * (по умолчанию `WEAK_LOSS_E_CENTER = 0.02`). Полезно для A/B
   * калибровки или юнит-тестов. Должно быть согласовано с
   * `weakLossSoftWidth`.
   */
  weakLossCenter?: number;
  /**
   * (KS-4107) Опциональное переопределение полной ширины переходной
   * зоны soft-threshold (по умолчанию `WEAK_LOSS_E_SOFT_WIDTH = 0.01`).
   * Значение `0` деградирует метрику в ступеньку (legacy v1
   * совместимость для отладки).
   */
  weakLossSoftWidth?: number;
}

export interface WeakSetEntry {
  move: string;
  /** policy-вероятность хода по Maia (та же что в input.policy). */
  policy: number;
  /** Потеря в expected-score относительно best: `bestE − E(move)`. */
  lossE: number;
  /**
   * (KS-4107, metric_version=2) Вес «слабости» хода на интервале 0..1.
   * Вклад хода в `weakChoiceProb` равен `policy * weight`. Для
   * совместимости с дебагом v1: weight = 1 эквивалентно «полностью
   * слабый» (loss_E ≥ center + width/2), weight = 0 — «полностью
   * сильный» (loss_E ≤ center − width/2).
   */
  weight: number;
}

export interface WeakChoiceResult {
  /**
   * `Σ policy[m] · weight(m)` для всех m ∈ MaiaTopK (где weight = 0
   * для «точно сильных», 1 для «точно слабых», 0..1 в переходной
   * зоне). 0..1. Это значение и идёт в БД как
   * `puzzles.maia_weak_choice_prob`. Если weak_set пустой
   * (все weight = 0) — 0.
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
  /**
   * Ходы из MaiaTopK с ненулевым весом «слабости» (для лога/report).
   * Не включает ходы с `weight = 0` (полностью сильные). Включает
   * все ходы с `weight > 0` — как в переходной зоне, так и полностью
   * слабые (`weight = 1`).
   */
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
 * Полный вычислитель `maiaWeakChoiceProb` по ADR-106 §2.1 +
 * soft-threshold KS-4107 (metric_version=2).
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
 *  - Несколько равно-сильных в MaiaTopK (loss_E ≤ center − width/2) →
 *    все weight = 0 → weak_set пустой → `weakChoiceProb = 0`.
 *  - Ход в переходной зоне (loss_E между center − width/2 и
 *    center + width/2) → 0 < weight < 1, ход попадает в weakSet с
 *    дробным весом, вклад в prob = policy · weight.
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

  const center = input.weakLossCenter ?? WEAK_LOSS_E_CENTER;
  const width = input.weakLossSoftWidth ?? WEAK_LOSS_E_SOFT_WIDTH;

  const weakSet: WeakSetEntry[] = [];
  let weakChoiceProb = 0;
  for (const move of maiaTopK) {
    const e = input.expectedScores.get(move);
    if (e === undefined) continue;
    const lossE = bestE - e;
    const weight = weakWeight(lossE, center, width);
    if (weight <= 0) continue;
    const policy = policyByMove.get(move) ?? 0;
    weakSet.push({ move, policy, lossE, weight });
    weakChoiceProb += policy * weight;
  }

  return {
    weakChoiceProb,
    maiaTopK,
    searchMoves,
    bestExpectedScore: bestE,
    weakSet,
  };
}
