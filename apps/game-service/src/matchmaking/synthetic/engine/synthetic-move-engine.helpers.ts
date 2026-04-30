/**
 * KS-2161 (B8). Чистые helpers для SyntheticMoveEngineService — выбор хода
 * из multipv-кандидатов, блантер-инжектор, sanity-check на пропуск мата,
 * расчёт времени размышления.
 *
 * Все функции детерминированы при подмене `random()` — потому что юнит-тесты
 * проверяют точное поведение weighted-выбора и долей.
 */

import type { TimeControlCategory } from '@kingside/shared';

// ─── Phase ────────────────────────────────────────────────────────────

export type EnginePhase = 'opening' | 'middlegame' | 'endgame';

/**
 * Простой phase-detector по plyCount.
 *   - ply ≤ 20  → opening (ADR §5.1).
 *   - ply ≤ 60  → middlegame.
 *   - else      → endgame.
 *
 * Эндгейм может быть и раньше — но для тайминга/multipv-шума этого
 * достаточно. Точный детектор (по material) — вне scope.
 */
export function phaseFromPly(plyCount: number): EnginePhase {
  if (plyCount <= 20) return 'opening';
  if (plyCount <= 60) return 'middlegame';
  return 'endgame';
}

// ─── Multipv selection (ADR §5.3) ─────────────────────────────────────

export interface MultipvLine {
  /** Индекс multipv (1=best, 2, 3, ...). */
  rank: number;
  /** UCI хода (`e2e4`, `g1f3` и т.п.). */
  uci: string;
  /**
   * Score в сантипешках с точки зрения ХОДЯЩЕГО (positive = good for us).
   * Mate-score кодируется как `null` + `mateIn`.
   */
  scoreCp: number | null;
  /** Mate-в-N, если применимо. Положительное — мы матуем, отрицательное — нас. */
  mateIn: number | null;
}

/**
 * Распределение Best/2nd/3rd по rating'у синтета. ADR §5.3.
 *   `< 1500`     : 70 / 22 / 8
 *   `1500..1899` : 80 / 16 / 4
 *   `1900..2099` : 88 / 10 / 2
 *   `2100+`      : 94 / 5  / 1
 */
export function multipvWeightsForRating(
  rating: number,
): readonly [number, number, number] {
  if (rating < 1500) return [70, 22, 8];
  if (rating < 1900) return [80, 16, 4];
  if (rating < 2100) return [88, 10, 2];
  return [94, 5, 1];
}

/**
 * Условие из ADR §5.3: 2nd/3rd допускаются только если разница в оценке
 * с лучшим ходом ≤ 150 cp. Mate-варианты исключаются — такие ходы
 * игнорируем для шума.
 */
export const MULTIPV_NOISE_MAX_CP_DIFF = 150;

/**
 * Возвращает кандидатов 1/2/3 индекса, прошедших фильтр близости eval'у
 * лучшего. Кандидат 1 (best) — всегда. Кандидат 2/3 включается, если
 * `|score(best) − score(N)| ≤ 150 cp` И не mate-вариант.
 */
export function eligibleMultipvCandidates(
  lines: readonly MultipvLine[],
): MultipvLine[] {
  if (lines.length === 0) return [];
  const sorted = [...lines]
    .filter((l) => l.scoreCp !== null || l.mateIn !== null)
    .sort((a, b) => a.rank - b.rank);
  if (sorted.length === 0) return [];

  const out: MultipvLine[] = [sorted[0]];
  const bestScore = sorted[0].scoreCp;
  for (let i = 1; i < sorted.length && out.length < 3; i++) {
    const line = sorted[i];
    if (line.scoreCp === null) continue; // mate-варианты не для шума
    if (bestScore === null) continue; // если best — mate, шум не делаем
    const diff = Math.abs(bestScore - line.scoreCp);
    if (diff <= MULTIPV_NOISE_MAX_CP_DIFF) out.push(line);
  }
  return out;
}

/**
 * Выбор multipv-кандидата по таблице долей (ADR §5.3). `random()` —
 * подменяемый источник энтропии (для тестов).
 *
 * Возвращает выбранный кандидат и его «индекс шума» (0=best, 1=2nd, 2=3rd).
 * Если кандидат всего один (best), всегда возвращается он.
 */
export function pickWithMultipvNoise(
  candidates: readonly MultipvLine[],
  rating: number,
  random: () => number = Math.random,
): { line: MultipvLine; noiseIndex: 0 | 1 | 2 } {
  if (candidates.length === 0) {
    throw new Error('pickWithMultipvNoise: no candidates');
  }
  if (candidates.length === 1) {
    return { line: candidates[0], noiseIndex: 0 };
  }
  const weights = multipvWeightsForRating(rating);
  const r = random() * 100;
  let acc = 0;
  for (let i = 0; i < Math.min(candidates.length, weights.length); i++) {
    acc += weights[i];
    if (r < acc) {
      return { line: candidates[i], noiseIndex: i as 0 | 1 | 2 };
    }
  }
  // Если суммарный вес меньше 100 (только 2 кандидата) — отдаём последний.
  return {
    line: candidates[candidates.length - 1],
    noiseIndex: (candidates.length - 1) as 0 | 1 | 2,
  };
}

// ─── Blunder injector (ADR §5.4) ──────────────────────────────────────

/**
 * Для рейтинга < 1000 (где UCI_Elo минимум 1320 не работает корректно):
 *   - 5..15% ходов выбираем 4-6-й по multipv (хуже, но не катастрофа);
 *   - 1..2% ходов делаем «зевок» (берём произвольный 4-6-й независимо
 *     от близости eval'а, чтобы материал реально потерялся).
 *
 * Возвращает:
 *   - `'normal'` — без вмешательства;
 *   - `'sub-optimal'` — пятый-шестой по multipv (если есть в `lines`);
 *   - `'blunder'` — преднамеренный зевок.
 */
export type BlunderDecision = 'normal' | 'sub-optimal' | 'blunder';

export function decideBlunder(
  rating: number,
  random: () => number = Math.random,
): BlunderDecision {
  if (rating >= 1000) return 'normal';
  const r = random() * 100;
  if (r < 1.5) return 'blunder'; // 1.5% — внутри 1..2%
  if (r < 1.5 + 10) return 'sub-optimal'; // 10% — внутри 5..15%
  return 'normal';
}

/**
 * При `'sub-optimal'` или `'blunder'` берём 4-6-й кандидат по multipv.
 * Если в multipv меньше 4 линий — fallback на последнюю доступную линию
 * (худший из имеющихся). Возвращает выбранный uci или null если линий нет.
 */
export function pickSubOptimalOrBlunder(
  allLines: readonly MultipvLine[],
  random: () => number = Math.random,
): MultipvLine | null {
  if (allLines.length === 0) return null;
  const sorted = [...allLines].sort((a, b) => a.rank - b.rank);
  if (sorted.length <= 1) return sorted[0] ?? null;
  // Берём 4-6-й (rank 4..6 = индексы 3..5). Если их нет — последний.
  const candidates = sorted.filter((l) => l.rank >= 4 && l.rank <= 6);
  if (candidates.length === 0) return sorted[sorted.length - 1];
  return candidates[Math.floor(random() * candidates.length)];
}

// ─── Sanity check (ADR §5.5) ──────────────────────────────────────────

/**
 * После выбора хода с шумом — короткий depth=14 анализ. Если выбранный
 * ход даёт сопернику `mate -2` или `mate -3` (с нашей стороны), то
 * подменяем на чистый `best`. Это критично — пропуск мата в 1-3 главный
 * признак, что ходишь не с человеком.
 *
 * На вход — score-after-our-move с точки зрения СОПЕРНИКА (положительное
 * mate = соперник матует нас).
 */
export interface SanityCheckInput {
  candidate: MultipvLine;
  best: MultipvLine;
  /**
   * mateIn после нашего хода (сторона соперника). >0 — соперник матует
   * нас за N ходов, null — мата нет в горизонте depth=14.
   */
  mateForOpponentAfterCandidate: number | null;
}

export function sanityCheckMateInTwoOrThree(
  input: SanityCheckInput,
): MultipvLine {
  const m = input.mateForOpponentAfterCandidate;
  // Защита: если соперник матует нас в 1-3 хода после нашего candidate —
  // подменяем на best. mate-in-1 покрывает крайний кейс «пропустили
  // одно-ходовый мат», mate-in-2/3 — основной хук ADR §5.5.
  if (m !== null && m >= 1 && m <= 3) {
    return input.best;
  }
  return input.candidate;
}

// ─── Timing (ADR §6) ──────────────────────────────────────────────────

/**
 * Mean think time по (category, phase) в миллисекундах. ADR §6 (Q-таблица
 * thinking time).
 *
 * Эти числа — стартовый дефолт; их можно отъюстить в проде через
 * env / админку без ребилда (отдельная задача).
 */
export const SYNTHETIC_THINK_MEAN_MS: Record<
  TimeControlCategory,
  Record<EnginePhase, number>
> = {
  bullet: {
    opening: 600,
    middlegame: 1200,
    endgame: 800,
  },
  blitz: {
    opening: 1500,
    middlegame: 4000,
    endgame: 2500,
  },
  rapid: {
    opening: 4000,
    middlegame: 12_000,
    endgame: 8_000,
  },
  classical: {
    opening: 8_000,
    middlegame: 30_000,
    endgame: 20_000,
  },
};

/**
 * Hard cap по категории — выше клиент будет «думать слишком долго»
 * для своего time control'а. ADR §6.
 */
export const SYNTHETIC_THINK_HARD_CAP_MS: Record<TimeControlCategory, number> = {
  bullet: 4_000,
  blitz: 12_000,
  rapid: 30_000,
  classical: 90_000,
};

const MIN_THINK_MS = 200;

/**
 * Box-Muller normal (mean=0, std=1). Подмешивается через `random()`.
 */
export function jitterNormal(
  random: () => number = Math.random,
): number {
  const u1 = Math.max(Number.EPSILON, random());
  const u2 = random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Расчёт времени размышления одного хода.
 *
 * Формула (ADR §6):
 *   `baseThinkMs = clamp(jitterNormal(mean, σ=0.4×mean), 200, hardCap)`
 *
 * + 3% долгая дума (×3 множитель), + correction по сложности позиции
 *   (eval-разница):
 *     diff <  20 cp  → ×0.8 (тривиальная)
 *     diff < 100 cp  → ×1.0 (стандартная)
 *     diff < 300 cp  → ×1.3 (сложная)
 *     иначе         → ×1.6 (критическая)
 * + реакция: 200 ms база + jitter [0..500] ms.
 *
 * Все случайные источники подменяемы для тестов.
 */
export interface ComputeThinkMsInput {
  category: TimeControlCategory;
  phase: EnginePhase;
  /** Eval-разница между лучшими двумя multipv-линиями в cp (по модулю). */
  evalDiffCp: number;
  random?: () => number;
}

export function computeThinkMs(input: ComputeThinkMsInput): number {
  const random = input.random ?? Math.random;
  const mean = SYNTHETIC_THINK_MEAN_MS[input.category][input.phase];
  const hardCap = SYNTHETIC_THINK_HARD_CAP_MS[input.category];
  const sigma = 0.4 * mean;

  // 3% — долгая дума.
  const longThink = random() < 0.03;

  // Сложность позиции.
  const diff = Math.abs(input.evalDiffCp);
  let complexityMul: number;
  if (diff < 20) complexityMul = 0.8;
  else if (diff < 100) complexityMul = 1.0;
  else if (diff < 300) complexityMul = 1.3;
  else complexityMul = 1.6;

  const noise = jitterNormal(random);
  let base = mean + noise * sigma;
  base *= complexityMul;
  if (longThink) base *= 3;

  // Реакция: 200 ms база + 0..500 ms jitter.
  const reactionMs = 200 + Math.floor(random() * 500);

  const total = Math.max(MIN_THINK_MS, Math.min(hardCap, Math.round(base))) + reactionMs;
  return total;
}
