/**
 * KS-2997 / ADR-065 §3.4. 5-балльная оценка решения precision-задачи.
 *
 * Чистая функция расчёта без side-effects. Используется:
 *  - сервером при создании `precision_attempts` (заполняет `score` /
 *    `scorePct` колонки, KS-2998 / B3 KS-2999);
 *  - бэкфилом legacy-attempt'ов (B5);
 *  - frontend'ом для предпросмотра (опционально, fallback на серверный).
 *
 * Алгоритм (ADR-065 §3.4):
 *
 *   1. Per-move accuracy → Lichess exponential formula:
 *      `103.1668 * exp(-0.04354 * loss_pct) - 3.1669`, clamp [0..100].
 *      Аргумент `loss_pct`:
 *        - Если есть `wdlBefore`/`wdlAfter`: `E = (w + d/2) / 1000`,
 *          `loss_pct = max(0, E_before - E_after) * 100` (ADR §2.1-2.3).
 *        - Если есть `cpBefore`/`cpAfter`: Lichess CP→Win формула
 *          `50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)` (§2.4.1).
 *        - Иначе fallback по classification (§2.4.2).
 *   2. Worst classification определяется по всем ходам с
 *      непустой `classification` (best < good < inaccuracy < mistake <
 *      blunder).
 *   3. Композит: `score_pct = 0.7 * mean(acc) + 0.3 * min(acc)`
 *      (§3.1, веса именованные для калибровки A1).
 *   4. Worst-class cap (§3.3): blunder → ≤ 60, mistake → ≤ 80.
 *   5. Star-mapping (§4): 95+ → 5★, 85+ → 4★, 70+ → 3★, 50+ → 2★, иначе 1★.
 *
 * Спец-кейсы (§3.4):
 *  - `moves.length < 2` → `{stars: null, scorePct: null}` (слишком
 *    короткая попытка).
 *  - data-points < 50% от moves → `null` (>50% gaps).
 *
 * Контрольные кейсы — `precision-score.test.ts`, 9 синтетических
 * сценариев из §4.3 + edge cases.
 */
import type { Wdl } from './wdl.js';

/** Классификация одного полухода (ADR-056 §2.5). */
export type PrecisionMoveClass =
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

/**
 * Минимальный набор данных одного user-полухода для расчёта score.
 * Совместим с `PrecisionMoveDto` из `api-contracts.ts` (все поля —
 * подмножество). Все поля кроме `classification` опциональны: если
 * нет WDL и нет cp, classification используется как fallback.
 */
export interface PrecisionMoveInput {
  wdlBefore?: Wdl | null;
  wdlAfter?: Wdl | null;
  cpBefore?: number | null;
  cpAfter?: number | null;
  classification?: PrecisionMoveClass | null;
  /**
   * KS-3030. Прямой override: ход совпал с PV1 движка. Если задано
   * `true`, `accuracyMove` возвращает строго 100 — независимо от WDL/cp.
   * Эквивалент проверки `playedUci === bestUci` на стороне caller'а.
   * Когда не задано — override срабатывает по `classification === 'best'`.
   */
  isBestMove?: boolean;
  /**
   * KS-3030 (опционально). UCI сыгранного и PV1-хода. Если оба
   * заданы и совпадают — override на accuracy=100 срабатывает.
   * Удобно когда вызывающий не вычисляет `isBestMove` сам.
   */
  playedUci?: string;
  bestUci?: string;
}

export interface PrecisionScoreResult {
  /** 1..5 stars; `null` если данных недостаточно (§3.4). */
  stars: 1 | 2 | 3 | 4 | 5 | null;
  /** 0..100 score_pct до округления до звёзд; `null` синхронно со stars. */
  scorePct: number | null;
}

// ─── Калибровочные константы (ADR-065 §3, §4) ─────────────────────
//
// Хранятся как именованные константы по двум причинам (риск #1, #2):
//  - этап 5 (A1) может скорректировать веса/пороги по реальным данным;
//  - изменение одной строки + бэкфил даёт новую калибровку без миграций.

/** ADR-065 §4: границы scorePct для каждой звезды (нижняя включительно). */
export const STAR_THRESHOLDS = {
  five: 95,
  four: 85,
  three: 70,
  two: 50,
} as const;

/** ADR-065 §3.1: веса композита mean+min. Сумма = 1.0. */
export const COMPOSITE_MEAN_WEIGHT = 0.7;
export const COMPOSITE_MIN_WEIGHT = 0.3;

/** ADR-065 §3.3: hard cap по worst-classification. */
export const WORST_CLASS_CAP: Record<'blunder' | 'mistake', number> = {
  blunder: 60,
  mistake: 80,
};

/**
 * ADR-065 §2.4.2: fallback accuracy по classification, когда нет ни
 * WDL, ни cp. Числа подобраны так, чтобы при стандартных диапазонах
 * cpLoss exp-formula давала похожий результат (см. ADR §2.4.2).
 */
export const CLASSIFICATION_FALLBACK_ACCURACY: Record<
  PrecisionMoveClass,
  number
> = {
  best: 95,
  good: 80,
  inaccuracy: 55,
  mistake: 25,
  blunder: 5,
};

/**
 * ADR-065 §3.2 (KS-3033). Минимум полуходов для расчёта score.
 *
 * Изначально =2 (ADR-065 §3.2: «1 ход — бросок монеты, не оценка»),
 * но регрессия по UX: 1-ходовые attempt'ы (например `Nxc6??` =
 * blunder с WDL 100%→0%) показывали «Балл недоступен» вместо звезды,
 * хотя старая бинарная плашка «Преимущество потеряно» отображалась.
 *
 * KS-3033: понижено до **1**. Кейсы:
 *  - 1 best → 5★ (через best-override KS-3030).
 *  - 1 mistake (loss_E=0.20) → composite=40 без cap → 1★;
 *    с cap mistake=80 не активируется (40<80) → 1★.
 *  - 1 blunder (loss_E=0.30+) → composite низкий, cap blunder=60
 *    не активируется → 1★.
 *
 * Композит mean+min на одном ходе вырождается в mean = min = accuracy
 * этого хода. Cap по worst-class всё ещё страхует (для синхронности
 * с многоходовыми attempt'ами).
 */
export const MIN_HALF_MOVES_FOR_SCORE = 1;

/**
 * ADR-065 §3.4: минимальная доля ходов с реальными данными
 * (WDL/cp/classification) — иначе score=null. >50% gaps.
 */
export const MIN_DATA_FRACTION = 0.5;

// ─── Lichess accuracy formula (ADR §2.3, §2.4.1) ──────────────────

/** Lichess accuracy константы: `103.1668 * exp(-0.04354 * loss) - 3.1669`. */
const ACC_A = 103.1668;
const ACC_B = -0.04354;
const ACC_C = -3.1669;

/** Lichess CP→Win константа: `2 / (1 + exp(-0.00368208 * cp))`. */
const CP_TO_WIN_K = -0.00368208;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Lichess CP→Win% (§2.4.1). cp ∈ ℝ (signed, POV игрока), результат
 * ∈ [0, 100]. Используется для legacy-attempt'ов без WDL.
 */
export function winPctFromCp(cp: number): number {
  if (!Number.isFinite(cp)) return 50;
  const raw = 50 + 50 * (2 / (1 + Math.exp(CP_TO_WIN_K * cp)) - 1);
  return clamp(raw, 0, 100);
}

/**
 * Per-move accuracy в [0..100] (Lichess formula, §2.3). Возвращает
 * `null` если данных нет вообще (`wdl=null && cp=null && classification=null`).
 *
 * Порядок проверок:
 *  0. **KS-3030 override**: если ход совпал с PV1 движка (явный
 *     `isBestMove === true`, либо `playedUci === bestUci`, либо
 *     `classification === 'best'`) → `100`. Без расчёта по WDL/cp.
 *     Это устраняет рассинхрон с `classifyMove`: NAG `!` (best) на ходе
 *     теперь всегда означает 100% accuracy, без шума WDL между depths
 *     Stockfish.
 *  1. wdlBefore + wdlAfter → expected-score `E = (w + d/2) / 1000`,
 *     loss = max(0, E_before - E_after) * 100.
 *  2. cpBefore + cpAfter → Lichess CP→Win%.
 *  3. classification → таблица §2.4.2.
 */
export function accuracyMove(move: PrecisionMoveInput): number | null {
  // KS-3030: best-override. NAG `!` ⟺ accuracy=100 (согласует обе шкалы).
  const playedMatchesBest =
    typeof move.playedUci === 'string' &&
    typeof move.bestUci === 'string' &&
    move.playedUci === move.bestUci;
  if (
    move.isBestMove === true ||
    playedMatchesBest ||
    move.classification === 'best'
  ) {
    return 100;
  }

  if (move.wdlBefore && move.wdlAfter) {
    const eBefore =
      (move.wdlBefore.w + move.wdlBefore.d / 2) / 1000;
    const eAfter = (move.wdlAfter.w + move.wdlAfter.d / 2) / 1000;
    const lossPct = Math.max(0, eBefore - eAfter) * 100;
    return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
  }
  if (typeof move.cpBefore === 'number' && typeof move.cpAfter === 'number') {
    const winBefore = winPctFromCp(move.cpBefore);
    const winAfter = winPctFromCp(move.cpAfter);
    const lossPct = Math.max(0, winBefore - winAfter);
    return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
  }
  if (move.classification) {
    return CLASSIFICATION_FALLBACK_ACCURACY[move.classification];
  }
  return null;
}

/**
 * Worst classification среди ходов. `null` если ни у одного хода нет
 * classification. Порядок: best < good < inaccuracy < mistake < blunder.
 */
const CLASS_ORDER: readonly PrecisionMoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;

export function worstClassification(
  moves: PrecisionMoveInput[],
): PrecisionMoveClass | null {
  let worstIdx = -1;
  for (const m of moves) {
    if (!m.classification) continue;
    const idx = CLASS_ORDER.indexOf(m.classification);
    if (idx > worstIdx) worstIdx = idx;
  }
  return worstIdx >= 0 ? CLASS_ORDER[worstIdx] : null;
}

/**
 * scorePct → 1..5 звёзд (§4). Нижняя граница включительно: 95.0 → 5★,
 * 94.99 → 4★. Эффект «cliff» намеренный (риск #11).
 */
export function mapToStars(scorePct: number): 1 | 2 | 3 | 4 | 5 {
  if (scorePct >= STAR_THRESHOLDS.five) return 5;
  if (scorePct >= STAR_THRESHOLDS.four) return 4;
  if (scorePct >= STAR_THRESHOLDS.three) return 3;
  if (scorePct >= STAR_THRESHOLDS.two) return 2;
  return 1;
}

/**
 * Aggregate готовых accuracies в финальный score. Вынесено отдельно
 * для прямой проверки контрольных кейсов §4.3 (без построения wdl-
 * входов). Применяет композит mean+min и worst-class cap.
 *
 * `accuracies` — список значений в [0..100]; ≥1 элемент.
 * `worst` — worst-classification из исходных ходов; используется
 * только для cap'а (`null` ⇒ cap не применяется).
 */
export function aggregateAccuracies(
  accuracies: number[],
  worst: PrecisionMoveClass | null,
): PrecisionScoreResult {
  if (accuracies.length === 0) return { stars: null, scorePct: null };
  const mean =
    accuracies.reduce((acc, v) => acc + v, 0) / accuracies.length;
  let min = accuracies[0];
  for (let i = 1; i < accuracies.length; i++) {
    if (accuracies[i] < min) min = accuracies[i];
  }
  let scorePct =
    COMPOSITE_MEAN_WEIGHT * mean + COMPOSITE_MIN_WEIGHT * min;
  if (worst === 'blunder') {
    scorePct = Math.min(scorePct, WORST_CLASS_CAP.blunder);
  } else if (worst === 'mistake') {
    scorePct = Math.min(scorePct, WORST_CLASS_CAP.mistake);
  }
  return { stars: mapToStars(scorePct), scorePct };
}

/**
 * KS-2997 / ADR-065 §3.4. Главная функция: вход — массив user-полуходов
 * (минимальный набор полей `PrecisionMoveInput`), выход — `{stars, scorePct}`.
 *
 * Чистая (без side-effects, без I/O, deterministic), легко тестируется.
 *
 * Возвращает `{stars: null, scorePct: null}` если:
 *  - `moves.length < MIN_HALF_MOVES_FOR_SCORE` (§3.2);
 *  - менее `MIN_DATA_FRACTION` ходов имеют данные для расчёта (§3.4
 *    «>50% gaps» case).
 */
export function computePrecisionScore(
  moves: PrecisionMoveInput[],
): PrecisionScoreResult {
  if (moves.length < MIN_HALF_MOVES_FOR_SCORE) {
    return { stars: null, scorePct: null };
  }
  const accuracies: number[] = [];
  for (const m of moves) {
    const a = accuracyMove(m);
    if (a !== null) accuracies.push(a);
  }
  if (accuracies.length < moves.length * MIN_DATA_FRACTION) {
    return { stars: null, scorePct: null };
  }
  return aggregateAccuracies(accuracies, worstClassification(moves));
}

// ─── KS-3246: цель пазла + ось goal_achieved ──────────────────────

// Жанр пазла (ADR-069). Тип определён в `./puzzle-gen-core.ts` —
// импортируем оттуда чтобы не дублировать определение и не плодить
// конфликт re-export'ов в `src/index.ts`.
import type { PuzzleObjective } from './puzzle-gen-core.js';

/**
 * KS-3246. Пороги «снисхождения» для goal_achieved.
 *
 * Дельты small-positive: end_E может быть чуть меньше start_E из-за
 * приближения движка (depth↑ → eval колеблется на ±0.01..0.02), это
 * не означает «упустил перевес». Для saveEquality зона шире — там цель
 * «не дать упасть», объяснимое колебание выше.
 *
 * Числа из chess-expert review (KS-3246). Калибровка возможна после
 * 7-14 дней живых данных, см. ADR-065 §5 (этап A1).
 */
export const OBJECTIVE_TOLERANCE: Record<PuzzleObjective, number> = {
  convertAdvantage: 0.02,
  saveEquality: 0.05,
};

/**
 * KS-3246. Достигнута ли цель пазла. Чистая функция от пары E-значений
 * и жанра. Используется и при создании attempt'а в сервисе, и при
 * backfill (тогда вместо real-time данных берётся из БД).
 *
 * Аргументы:
 *  - `startE`, `endE` ∈ [0..1] — expected-score POV игрока в начале
 *    и в конце attempt'а: `E = (W + D/2) / 1000`.
 *  - `objective` — `convertAdvantage` или `saveEquality`.
 *
 * Правила:
 *  - convertAdvantage: end_E ≥ start_E − OBJECTIVE_TOLERANCE.convert
 *  - saveEquality:     end_E ≥ start_E − OBJECTIVE_TOLERANCE.save
 *
 * Возвращает `null` если данных нет (любой из E === null).
 */
export function evaluateObjectiveAchieved(
  startE: number | null | undefined,
  endE: number | null | undefined,
  objective: PuzzleObjective,
): boolean | null {
  if (typeof startE !== 'number' || typeof endE !== 'number') return null;
  if (!Number.isFinite(startE) || !Number.isFinite(endE)) return null;
  const tolerance = OBJECTIVE_TOLERANCE[objective];
  return endE >= startE - tolerance;
}

/**
 * KS-3246. Wrapper: достаёт start_E / end_E из массива user-полуходов
 * (`PrecisionMoveInput[]` — те же, что для `computePrecisionScore`) и
 * вычисляет `objectiveAchieved`. Берёт первый move с непустым
 * `wdlBefore` для start_E и последний move с непустым `wdlAfter` для
 * end_E.
 *
 * Возвращает `null` если данных нет (legacy без WDL).
 */
export function computeAttemptObjectiveAchieved(
  moves: PrecisionMoveInput[],
  objective: PuzzleObjective,
): boolean | null {
  let startE: number | null = null;
  for (const m of moves) {
    if (m.wdlBefore) {
      startE = (m.wdlBefore.w + m.wdlBefore.d / 2) / 1000;
      break;
    }
  }
  let endE: number | null = null;
  for (let i = moves.length - 1; i >= 0; i--) {
    const wdlAfter = moves[i].wdlAfter;
    if (wdlAfter) {
      endE = (wdlAfter.w + wdlAfter.d / 2) / 1000;
      break;
    }
  }
  return evaluateObjectiveAchieved(startE, endE, objective);
}

/**
 * KS-3246 / KS-3248. Verdict-key для frontend-плашки. Матрица 5×2
 * (звёзды × goal_achieved). Текст самой плашки рендерится фронтом
 * (i18n, KS-3248), backend отдаёт только key.
 *
 * GOAL_ACHIEVED = true:
 *   5★ → 'flawless'         — «Идеально решено»
 *   4★ → 'confident'        — «Уверенно решено. Есть мелкие неточности»
 *   3★ → 'suboptimal'       — «Решено, но не лучшим путём»
 *   2★ → 'with-mistakes'    — «Решено, но с ошибками»
 *   1★ → 'with-blunders'    — «Цель достигнута, но с грубыми ошибками»
 *
 * GOAL_ACHIEVED = false:
 *   5★ → 'flawless' (с warn — теоретически невозможно, см. ниже)
 *   4★ → 'goal-missed-clean'    — «Хорошее исполнение, но цель не достигнута»
 *   3★ → 'goal-missed'          — «Цель не достигнута»
 *   2★ → 'goal-missed-mistakes' — «Цель не достигнута, были ошибки»
 *   1★ → 'goal-missed-blunders' — «Не решено. Грубые ошибки»
 *
 * GOAL_ACHIEVED = null: используется ветка `true` (legacy без данных
 * — фронт ведёт себя как раньше).
 *
 * Защитный fallback: 5★ + goal_achieved=false комбинация теоретически
 * невозможна (5 звёзд требует accuracy ≥95, что подразумевает ходы PV1,
 * и goal должен быть достигнут). Если всё-таки возникает (баг данных) —
 * возвращаем 'flawless', понижение делает сервис с warn в логе.
 */
export type PrecisionVerdictKey =
  | 'flawless'
  | 'confident'
  | 'suboptimal'
  | 'with-mistakes'
  | 'with-blunders'
  | 'goal-missed-clean'
  | 'goal-missed'
  | 'goal-missed-mistakes'
  | 'goal-missed-blunders';

export function computeVerdictKey(
  stars: 1 | 2 | 3 | 4 | 5 | null,
  objectiveAchieved: boolean | null,
): PrecisionVerdictKey | null {
  if (stars === null) return null;
  // null = нет данных о goal: рендерим как «достигнуто» (legacy).
  const achieved = objectiveAchieved === false ? false : true;
  if (achieved) {
    switch (stars) {
      case 5: return 'flawless';
      case 4: return 'confident';
      case 3: return 'suboptimal';
      case 2: return 'with-mistakes';
      case 1: return 'with-blunders';
    }
  }
  switch (stars) {
    case 5: return 'flawless'; // теоретически невозможно
    case 4: return 'goal-missed-clean';
    case 3: return 'goal-missed';
    case 2: return 'goal-missed-mistakes';
    case 1: return 'goal-missed-blunders';
  }
}
