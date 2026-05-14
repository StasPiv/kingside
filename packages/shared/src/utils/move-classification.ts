/**
 * KS-2717 → KS-3020 / ADR-066 §2-§3. Классификация хода игрока по
 * **WDL-loss** (с cp-fallback для legacy).
 *
 * История:
 *   - KS-2717 / ADR-056 §3.3: cp-loss как primary метрика.
 *     Пороги: best=0, good=30, inaccuracy=90, mistake=220.
 *   - KS-3020 / ADR-066: переход на WDL-loss как primary метрика —
 *     устранение UX-противоречия ★★★★★ vs `?` (когда WDL не меняется,
 *     но cp скачет на сотни пунктов в выигранной позиции). Единая
 *     шкала с precision-score (ADR-065).
 *
 * Категории — стандартные для шахматных трекеров (lichess / chess.com):
 *   - `best`        — `playedUci === bestUci` ИЛИ loss_E ≤ 0.02
 *                     ИЛИ `wdl_after.w > 950` (мат сопернику).
 *   - `good`        — 0.02 < loss_E ≤ 0.05.
 *   - `inaccuracy`  — 0.05 < loss_E ≤ 0.12.
 *   - `mistake`     — 0.12 < loss_E ≤ 0.25.
 *   - `blunder`     — loss_E > 0.25 ИЛИ `wdl_after.l > 950` (подставил
 *                     под мат).
 *
 * Источник истины — серверный пересчёт. Клиентский результат не
 * считается доверенным (server-trust по ADR-056 §3.3): backend
 * получает WDL/cp от клиента, но classification выводит сам.
 *
 * Pure-функция, без побочных эффектов и зависимостей от DOM/node —
 * подходит и для frontend (apps/web), и для backend (apps/api).
 */
import { winPctFromCp } from './precision-score.js';

export type MoveClass =
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

/**
 * KS-2505 / ADR-049. Mate-оценки энкодятся как ±MATE_CP_BASE для
 * того, чтобы их можно было хранить в `Int32`-полях БД и сравнивать
 * стандартными числовыми операторами.
 *
 * MATE_CP_BASE = 100_000 — enkodiruem `mate(N)` как ±(100000 − |N|),
 * где знак — за чью пользу мат. Для классификации хода нам важно
 * только направление (огромный по модулю → решающее преимущество).
 */
export const MATE_CP_BASE = 100_000;

/**
 * KS-3020 / ADR-066 §3.2. Пороги loss_E (expected-score loss) для
 * классификации. Расчёт через Lichess accuracy-формулу
 * `accuracy = 103.1668 * exp(-0.04354 * loss_pct) - 3.1669`:
 *
 *   loss_E ≤ 0.02 ⟺ accuracy ≥ 91.4  → best
 *   loss_E ≤ 0.05 ⟺ accuracy ≥ 79.8  → good
 *   loss_E ≤ 0.12 ⟺ accuracy ≥ 58.0  → inaccuracy
 *   loss_E ≤ 0.25 ⟺ accuracy ≥ 31.6  → mistake
 *   loss_E >  0.25 ⟺ accuracy <  31.6 → blunder
 *
 * Именованные константы для калибровки A1 (анализ распределения
 * после 7-14 дней живых данных).
 */
export const WDL_LOSS_THRESHOLDS = {
  /** loss_E ≤ 0.02 → `best`. */
  best: 0.02,
  /** 0.02 < loss_E ≤ 0.05 → `good`. */
  good: 0.05,
  /** 0.05 < loss_E ≤ 0.12 → `inaccuracy`. */
  inaccuracy: 0.12,
  /** 0.12 < loss_E ≤ 0.25 → `mistake`. */
  mistake: 0.25,
} as const;

/**
 * KS-3020 / ADR-066 §2.3. Mate-edge: per-mille порог, при котором
 * WDL-распределение считается «гарантированным» исходом.
 * `wdl_after.l > 950` ⟹ blunder; `wdl_after.w > 950` ⟹ best.
 */
export const MATE_WDL_THRESHOLD = 950;

/**
 * @deprecated KS-3020 / ADR-066: cp-loss больше не primary метрика
 * классификации. Оставлено для редких внешних usages (если найдутся;
 * удаление — отдельный тикет). Внутри `classifyMove` cp используется
 * только через `winPctFromCp` как fallback при отсутствии WDL.
 *
 * Раньше:
 *   ≤ 0 → best, ≤ 30 → good, ≤ 90 → inaccuracy, ≤ 220 → mistake, > 220 → blunder.
 */
export const CP_LOSS_THRESHOLDS = {
  best: 0,
  good: 30,
  inaccuracy: 90,
  mistake: 220,
} as const;

/**
 * WDL-распределение в per-mille (0..1000). Сумма w+d+l ≈ 1000.
 * POV игрока, делающего ход (для wdlBefore) и того же игрока
 * (для wdlAfter — после хода + ответа движка, инвертирование уже
 * выполнено на стороне фронта при сборке snapshot, см. ADR-056 §3.2).
 */
export interface WdlPerMille {
  w: number;
  d: number;
  l: number;
}

export interface ClassifyMoveInput {
  /**
   * KS-3020 / ADR-066. WDL-распределение ДО хода. Если задано
   * вместе с `wdlAfter` — используется как primary источник loss_E
   * (приоритет над cp).
   * `null`/`undefined` — фолбек на cp (для legacy attempt'ов до
   * KS-2754).
   */
  wdlBefore?: WdlPerMille | null;
  /**
   * KS-3020 / ADR-066. WDL-распределение ПОСЛЕ хода (тот же POV).
   * Дополнительно: `wdlAfter.l > 950` → blunder, `wdlAfter.w > 950`
   * → best (mate-edge, §2.3).
   */
  wdlAfter?: WdlPerMille | null;
  /**
   * cp-оценка позиции ДО хода, POV side-to-move. Для mate
   * энкодится как ±MATE_CP_BASE (KS-2505).
   *
   * Используется как fallback, когда WDL отсутствует (legacy
   * attempt'ы). `null`/`undefined` + отсутствие WDL → `'good'`.
   */
  cpBefore?: number | null;
  /**
   * cp-оценка ПОСЛЕ хода, POV того же игрока.
   */
  cpAfter?: number | null;
  /**
   * `true` если ход игрока совпал с PV1 движка (best). Тогда
   * classification = `'best'` независимо от loss_E (ADR-066 §2.2).
   */
  isBestMove?: boolean;
}

/**
 * KS-3020 / ADR-066 §2. Серверный пересчёт `MoveClass`.
 *
 * Порядок проверок (важен — early returns):
 *   1. `isBestMove === true` → `best` (override §2.2).
 *   2. mate-edge на WDL: `wdl_after.l > 950` → `blunder`, иначе
 *      `wdl_after.w > 950` → `best` (§2.3).
 *   3. legacy mate-edge на cp (только если нет WDL):
 *      `cpAfter ≤ -MATE_CP_BASE/2` → `blunder`,
 *      `cpAfter ≥ MATE_CP_BASE/2` → `best`.
 *   4. WDL primary: `loss_E = max(0, E_before - E_after)`,
 *      `E = (w + d/2) / 1000`. Сравнить с порогами.
 *   5. cp fallback (только если нет WDL): `loss_E ≈
 *      (winPctFromCp(cpBefore) - winPctFromCp(cpAfter)) / 100`.
 *      Сравнить с порогами (та же шкала).
 *   6. Ни WDL, ни cp → `'good'` (нейтральный фолбек, не штрафуем
 *      игрока за провал движка).
 */
export function classifyMove(input: ClassifyMoveInput): MoveClass {
  // 1. isBestMove override (§2.2).
  if (input.isBestMove === true) return 'best';

  // 2. Mate-edge на WDL (§2.3).
  const wdlAfter = input.wdlAfter;
  if (wdlAfter) {
    if (wdlAfter.l > MATE_WDL_THRESHOLD) return 'blunder';
    if (wdlAfter.w > MATE_WDL_THRESHOLD) return 'best';
  }

  // 3. Legacy mate-edge на cp — только если WDL не задан.
  const hasWdl = !!(input.wdlBefore && input.wdlAfter);
  if (!hasWdl && typeof input.cpAfter === 'number') {
    if (input.cpAfter <= -MATE_CP_BASE / 2) return 'blunder';
    if (input.cpAfter >= MATE_CP_BASE / 2) return 'best';
  }

  // 4. WDL primary.
  let lossE: number | null = null;
  if (input.wdlBefore && input.wdlAfter) {
    const eBefore =
      (input.wdlBefore.w + input.wdlBefore.d / 2) / 1000;
    const eAfter = (input.wdlAfter.w + input.wdlAfter.d / 2) / 1000;
    lossE = Math.max(0, eBefore - eAfter);
  } else if (
    typeof input.cpBefore === 'number' &&
    typeof input.cpAfter === 'number'
  ) {
    // 5. cp fallback через Lichess winPctFromCp.
    const winBefore = winPctFromCp(input.cpBefore);
    const winAfter = winPctFromCp(input.cpAfter);
    lossE = Math.max(0, (winBefore - winAfter) / 100);
  }

  // 6. Ни WDL, ни cp → нейтральный фолбек.
  if (lossE === null) return 'good';

  // Пороги WDL_LOSS_THRESHOLDS (§3.2).
  if (lossE <= WDL_LOSS_THRESHOLDS.best) return 'best';
  if (lossE <= WDL_LOSS_THRESHOLDS.good) return 'good';
  if (lossE <= WDL_LOSS_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (lossE <= WDL_LOSS_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}
