/**
 * KS-2717 / ADR-056 §3.3. Классификация хода игрока по cp-loss
 * (или WDL-loss как фолбек).
 *
 * Категории — стандартные для шахматных трекеров (lichess / chess.com):
 *   - `best`        — ход совпал с PV1 движка (или потеря ≤ 0 cp).
 *   - `good`        — небольшое ухудшение (≤ 30 cp) — допустимая
 *                     неточность сильного ходa.
 *   - `inaccuracy`  — заметная неточность (≤ 90 cp).
 *   - `mistake`     — серьёзная ошибка (≤ 220 cp).
 *   - `blunder`     — зевок (> 220 cp).
 *
 * Источник истины — серверный пересчёт. Клиентский результат не
 * считаем доверенным (server-trust по ADR-056 §3.3): backend
 * получает `cpBefore`/`cpAfter` от клиента, но classification
 * выводит сам.
 *
 * Pure-функция, без побочных эффектов и зависимостей от DOM/node —
 * подходит и для frontend (apps/web), и для backend (apps/api).
 */

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
 * Пороги cp-loss для классификации.
 *
 * Подбирались с оглядкой на lichess (он использует динамические
 * пороги от стартовой оценки, но для PVE-attempts наша задача —
 * стабильно классифицировать ходы пользователя; начальные значения
 * хорошо подходят для среднего PVE-сегмента 1500–2500).
 */
export const CP_LOSS_THRESHOLDS = {
  /** ≤ 0 → `best`. */
  best: 0,
  /** > 0..30 → `good`. */
  good: 30,
  /** > 30..90 → `inaccuracy`. */
  inaccuracy: 90,
  /** > 90..220 → `mistake`; > 220 → `blunder`. */
  mistake: 220,
} as const;

export interface ClassifyMoveInput {
  /**
   * cp-оценка позиции ДО хода, POV side-to-move (= игрок,
   * который ходит). Для mate энкодится как ±MATE_CP_BASE
   * (см. KS-2505).
   *
   * `null` — Stockfish не вернул score (фолбек: классификация
   * вырождается до `'good'`).
   */
  cpBefore: number | null | undefined;
  /**
   * cp-оценка ПОСЛЕ хода, POV того же игрока (для этого нужно
   * инвертировать оценку Stockfish, который отдаст её от лица
   * новой стороны на ходу).
   *
   * `null` — фолбек до `'good'`.
   */
  cpAfter: number | null | undefined;
  /**
   * `true` если ход игрока совпал с PV1 движка (best). Тогда
   * classification = `'best'` независимо от cp-loss (учётной
   * погрешностью).
   */
  isBestMove?: boolean;
}

/**
 * Серверный пересчёт `MoveClass`. Логика:
 *   1. Если `isBestMove === true` — вернуть `'best'`.
 *   2. Если `cpBefore` или `cpAfter` отсутствуют — вернуть `'good'`
 *      (нейтральный фолбек: не штрафуем игрока за то, что движок
 *      не вернул оценку).
 *   3. Иначе вычислить `cpLoss = max(0, cpBefore − cpAfter)` (cp в
 *      пользу игрока «уехал» вниз — это потеря) и сравнить с
 *      порогами.
 *
 * Mate-логика:
 *   - Если ход забрал противника на мат (`cpAfter ≥ MATE_CP_BASE/2`),
 *     это всегда `'best'` — независимо от cpBefore.
 *   - Если ход подставил игрока под мат (`cpAfter ≤ −MATE_CP_BASE/2`),
 *     это всегда `'blunder'`.
 *
 * Возвращает один из `MoveClass`.
 */
export function classifyMove(input: ClassifyMoveInput): MoveClass {
  if (input.isBestMove === true) return 'best';

  const before = input.cpBefore;
  const after = input.cpAfter;
  if (before == null || after == null) {
    return 'good';
  }

  // Mate-катастрофа: сходил под мат.
  if (after <= -MATE_CP_BASE / 2) {
    return 'blunder';
  }
  // Заматовал: всегда best (даже если cpBefore был не топ).
  if (after >= MATE_CP_BASE / 2) {
    return 'best';
  }

  const cpLoss = Math.max(0, before - after);
  if (cpLoss <= CP_LOSS_THRESHOLDS.best) return 'best';
  if (cpLoss <= CP_LOSS_THRESHOLDS.good) return 'good';
  if (cpLoss <= CP_LOSS_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (cpLoss <= CP_LOSS_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}
