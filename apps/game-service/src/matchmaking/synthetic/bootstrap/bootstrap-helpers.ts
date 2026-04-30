/**
 * KS-2163. Чистые helpers для SyntheticBootstrapService:
 *   - подбор пар (rating ±150, лимит 3 партии с одним соперником);
 *   - выбор time control category (60% bullet/blitz, 30% rapid, 10% classical);
 *   - расчёт прогресса и ETA.
 *
 * Все случайные источники инжектируются (`rng()`), так что тесты
 * детерминированы и не требуют моков таймера.
 */

import type { TimeControlCategory } from '@kingside/shared';

// ─── Pair selection ───────────────────────────────────────────────────

export const PAIR_RATING_BAND = 150;
export const PAIR_MAX_REPEAT_PARTNER = 3;

export interface SyntheticCandidate {
  userId: string;
  rating: number;
  /** Сколько ВСЕГО партий уже сыграл synthetic (по любым tc). */
  gamesPlayed: number;
  /** Сколько партий сыграл с конкретным соперником (для ограничения repeat). */
  partnerCounts: Map<string, number>;
}

export interface SelectedPair {
  white: SyntheticCandidate;
  black: SyntheticCandidate;
}

/**
 * Выбирает пару для следующей bootstrap-партии.
 *
 * Правила:
 *   1. Берём synthetic с наименьшим `gamesPlayed` (приоритет «недогруженным»).
 *   2. Ищем партнёра в диапазоне rating ±150 и не более
 *      `PAIR_MAX_REPEAT_PARTNER` повторов с этим конкретным userId.
 *   3. Если кандидатов несколько — случайный пик через rng().
 *   4. Если никого не нашли — возвращаем `null` (caller: подождать или
 *      ослабить критерии).
 *
 * Цвет (white/black) тоже определяется rng — чтобы баланс по сторонам
 * был приблизительно равным.
 */
export function selectBootstrapPair(
  candidates: readonly SyntheticCandidate[],
  rng: () => number = Math.random,
): SelectedPair | null {
  if (candidates.length < 2) return null;
  const sorted = [...candidates].sort(
    (a, b) => a.gamesPlayed - b.gamesPlayed,
  );
  const a = sorted[0];
  const compatible = sorted.slice(1).filter((b) => {
    if (Math.abs(a.rating - b.rating) > PAIR_RATING_BAND) return false;
    const repeats = a.partnerCounts.get(b.userId) ?? 0;
    if (repeats >= PAIR_MAX_REPEAT_PARTNER) return false;
    return true;
  });
  if (compatible.length === 0) return null;
  const partner = compatible[Math.floor(rng() * compatible.length)];
  const aIsWhite = rng() < 0.5;
  return aIsWhite
    ? { white: a, black: partner }
    : { white: partner, black: a };
}

// ─── Time control distribution ─────────────────────────────────────────

/**
 * Дефолтное распределение по tc per ADR §2.3 (приближено к онлайн-стате):
 *   bullet  30% (был 60% «bullet/blitz» — делим пополам в стартовом дефолте,
 *           переопределяется через env).
 *   blitz   30%
 *   rapid   30%
 *   classical 10%
 */
export const DEFAULT_BOOTSTRAP_TC_DISTRIBUTION: ReadonlyArray<{
  category: TimeControlCategory;
  weight: number;
}> = [
  { category: 'bullet', weight: 30 },
  { category: 'blitz', weight: 30 },
  { category: 'rapid', weight: 30 },
  { category: 'classical', weight: 10 },
];

/**
 * Парсит env-строку формата `bullet=0.3,blitz=0.3,rapid=0.3,classical=0.1`
 * в weighted-distribution. Сохраняет порядок dist'а; нормирует веса (×100).
 * При невалидном значении возвращает default.
 */
export function parseTcDistribution(
  raw: string | undefined,
): ReadonlyArray<{ category: TimeControlCategory; weight: number }> {
  if (!raw) return DEFAULT_BOOTSTRAP_TC_DISTRIBUTION;
  const out: Array<{ category: TimeControlCategory; weight: number }> = [];
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || !v) continue;
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (k !== 'bullet' && k !== 'blitz' && k !== 'rapid' && k !== 'classical') continue;
    out.push({ category: k, weight: n * 100 });
  }
  if (out.length === 0) return DEFAULT_BOOTSTRAP_TC_DISTRIBUTION;
  return out;
}

export function pickTcCategory(
  distribution: ReadonlyArray<{ category: TimeControlCategory; weight: number }>,
  rng: () => number = Math.random,
): TimeControlCategory {
  const total = distribution.reduce((s, d) => s + d.weight, 0);
  if (total <= 0) return 'blitz';
  let r = rng() * total;
  for (const d of distribution) {
    r -= d.weight;
    if (r < 0) return d.category;
  }
  return distribution[distribution.length - 1].category;
}

// ─── Progress ─────────────────────────────────────────────────────────

export interface BootstrapProgress {
  /** Сколько synthetic'ов уже достигли target. */
  completed: number;
  /** Всего synthetic'ов в пуле. */
  totalSynthetics: number;
  /** Сколько партий ВСЕГО уже сыграно (sum по всем). */
  gamesPlayedTotal: number;
  /** Сколько партий ещё нужно сыграть. */
  gamesRemainingTotal: number;
  /** Готов ли bootstrap (`completed === totalSynthetics`). */
  done: boolean;
  /**
   * ETA в часах при текущем темпе. `null` если темп ещё не известен.
   */
  etaHours: number | null;
}

export function computeBootstrapProgress(
  syntheticGameCounts: ReadonlyMap<string, number>,
  target: number,
  /** Игр в час (rolling-rate). null = темп не известен ещё. */
  rateGamesPerHour: number | null,
): BootstrapProgress {
  let completed = 0;
  let gamesPlayedTotal = 0;
  let gamesRemainingTotal = 0;
  for (const count of syntheticGameCounts.values()) {
    gamesPlayedTotal += count;
    if (count >= target) {
      completed++;
    } else {
      gamesRemainingTotal += target - count;
    }
  }
  const totalSynthetics = syntheticGameCounts.size;
  const etaHours =
    rateGamesPerHour != null && rateGamesPerHour > 0
      ? gamesRemainingTotal / rateGamesPerHour
      : null;
  return {
    completed,
    totalSynthetics,
    gamesPlayedTotal,
    gamesRemainingTotal,
    done: completed === totalSynthetics && totalSynthetics > 0,
    etaHours,
  };
}
