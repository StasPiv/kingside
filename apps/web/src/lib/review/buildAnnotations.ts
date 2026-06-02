/**
 * KS-3603 (ADR-100 §3 — NAG авто-аннотация, §4 — variations).
 *
 * Pure-функция: на вход метрики SF+Maia по полуходу, на выход — NAG-set
 * и до двух side-variations (см. §4.3 «максимум 2»).
 *
 * Все пороги — захардкоженные дефолты ADR-100 §3.2, без конфигов на MVP.
 */

export interface MoveInput {
  /** 1-based индекс полухода. */
  ply: number;
  /** FEN до сыгранного хода. */
  fen: string;
  /** UCI сыгранного хода (`e2e4`). */
  playedUci: string;
  /** SF top-1 UCI. */
  sfBestUci: string;
  /**
   * Eval позиции с т. зр. ходящей стороны (мат → ±10000 ∓ N через
   * `mateToCp`). Если позиция уже выиграна/проиграна (>800) — NAG
   * suppress'ятся (§3.3).
   */
  cpBefore: number;
  /** Eval после SF-best (та же сторона), мат → ±10000 ∓ N. */
  cpBest: number;
  /** Eval после сыгранного хода (та же сторона). */
  cpPlayed: number;
  /** Eval second-best SF (multipv=2). Нужен для критерия !! (§3.2). */
  secondBestCp: number;
  /**
   * PV первой линии Stockfish (массив UCI). Используем `pv[0..2]` для
   * green-variation глубиной 3 (§4.1).
   */
  sfBestPv: string[];
  /** `policy[playedUci]` от Maia. `undefined` если Maia не отвечала. */
  playedProb: number | undefined;
  /** `policy[sfBestUci]` от Maia. */
  sfBestProb: number | undefined;
  /** Самый вероятный по Maia ход (UCI). */
  maiaTopUci: string;
  /** Probability Maia top-1. */
  maiaTopProb: number;
  /**
   * cpLoss если бы сыграли Maia top-1. Нужен для red-variation
   * «Maia-trap» (§4.2). Если нет данных — поставить -1 (то есть
   * red-variation не сработает).
   */
  maiaTopCpLoss: number;
  /**
   * §3.1 last bullet: forced move (все non-best с cpLoss ≥ 300 ИЛИ
   * один легальный ход).
   */
  forcedMove: boolean;
  /** SF mate-in-N перед ходом (`null` если нет мата). */
  mateBefore: number | null;
}

export type VariationColor = 'green' | 'red';

export interface AnnotationVariation {
  /** UCI первого хода вариации. */
  uci: string;
  color: VariationColor;
  /**
   * Доп. ходы вариации (UCI). Для green (§4.1) — `pv[1..2]`
   * (т.е. 2 ответных хода после первого). Для red (§4.2) — пусто
   * (глубина 1).
   */
  subline?: string[];
  /** NAG на первый ход вариации (для red — ? или ?? по cpLoss). */
  nag?: number[];
}

export interface Annotation {
  ply: number;
  /** Список NAG-кодов (см. §3.2). Пустой массив = нет NAG. */
  nag: number[];
  /** Не более 2 (см. §4.3). */
  variations: AnnotationVariation[];
}

// --- §3.2 NAG-коды ---------------------------------------------------------

export const NAG_BLUNDER = 4; // ??
export const NAG_MISTAKE = 2; // ?
export const NAG_DUBIOUS = 6; // ?!
export const NAG_INTERESTING = 5; // !?
export const NAG_GOOD = 1; // !
export const NAG_BRILLIANT = 3; // !!

// --- §3.4 mate ↔ cp --------------------------------------------------------

/** Конвертация SF score mate-in-N → integer cp-эквивалент. Положительный
 *  мат (за stm) → `+10000 - N`; отрицательный → `-10000 + N`. Clamp ±10000. */
export function mateToCp(mateInN: number): number {
  if (mateInN > 0) return Math.min(10000, 10000 - mateInN);
  if (mateInN < 0) return Math.max(-10000, -10000 - mateInN);
  return 0;
}

// --- core ------------------------------------------------------------------

/**
 * Выбирает NAG-код по таблице §3.2. Возвращает `null` если ни одно
 * правило не сработало или сработал suppress (§3.3).
 */
function pickNag(input: MoveInput): number | null {
  const {
    playedUci,
    sfBestUci,
    cpBefore,
    cpBest,
    cpPlayed,
    secondBestCp,
    playedProb,
    forcedMove,
  } = input;

  // §3.3 suppress: forced moves.
  if (forcedMove) return null;
  // §3.3 suppress: уже выигранный/проигранный эндшпиль.
  if (Math.abs(cpBefore) > 800) return null;

  const cpLoss = Math.max(0, cpBest - cpPlayed);
  const samePlayed = playedUci === sfBestUci;

  // §3.2 порядок: сначала самые серьёзные (??), затем по убыванию.
  // ??: cpLoss ≥ 200.
  if (cpLoss >= 200) return NAG_BLUNDER;
  // ?: 100 ≤ cpLoss < 200.
  if (cpLoss >= 100) return NAG_MISTAKE;
  // ?!: 50 ≤ cpLoss < 100 И playedUci ≠ sfBestUci.
  if (cpLoss >= 50 && !samePlayed) return NAG_DUBIOUS;
  // !?: cpLoss < 50 И played≠best И playedProb ≥ 0.30.
  if (
    cpLoss < 50 &&
    !samePlayed &&
    playedProb !== undefined &&
    playedProb >= 0.3
  ) {
    return NAG_INTERESTING;
  }
  // !!: played=best И playedProb<0.05 И cpLoss=0 И НЕ forced
  //     И (cpBefore - secondBestCp) ≥ 150.
  if (
    samePlayed &&
    cpLoss === 0 &&
    playedProb !== undefined &&
    playedProb < 0.05 &&
    cpBefore - secondBestCp >= 150
  ) {
    return NAG_BRILLIANT;
  }
  // !: played=best И playedProb<0.20 И cpLoss=0.
  if (
    samePlayed &&
    cpLoss === 0 &&
    playedProb !== undefined &&
    playedProb < 0.2
  ) {
    return NAG_GOOD;
  }

  return null;
}

/** §4.2: NAG для Maia-trap хода — по его cpLoss. */
function nagForMaiaTrap(maiaTopCpLoss: number): number | null {
  if (maiaTopCpLoss >= 200) return NAG_BLUNDER;
  if (maiaTopCpLoss >= 100) return NAG_MISTAKE;
  return null;
}

/**
 * §4.1: green-вариант «как надо было». Срабатывает на NAG ∈ {??, ?},
 * cpLoss ≥ 100 (это и есть условие тех NAG'ов), sfBest ≠ played.
 */
function maybeGreenVariation(
  input: MoveInput,
  appliedNag: number | null,
): AnnotationVariation | null {
  if (appliedNag !== NAG_BLUNDER && appliedNag !== NAG_MISTAKE) return null;
  if (input.sfBestUci === input.playedUci) return null;
  // pv[0..2] — три хода глубиной (включая sfBest); subline — это
  // продолжение после first move, т.е. pv[1] и pv[2].
  const subline = input.sfBestPv.slice(1, 3);
  return {
    uci: input.sfBestUci,
    color: 'green',
    subline,
  };
}

/**
 * §4.2: red-вариант «Maia-trap». Условие:
 * maiaTop ≠ sfBest И maiaTopProb ≥ 0.25 И maiaTopCpLoss ≥ 100
 * И played ≠ maiaTop.
 */
function maybeRedVariation(input: MoveInput): AnnotationVariation | null {
  const { maiaTopUci, sfBestUci, maiaTopProb, maiaTopCpLoss, playedUci } =
    input;
  if (maiaTopUci === sfBestUci) return null;
  if (maiaTopUci === playedUci) return null;
  if (maiaTopProb < 0.25) return null;
  if (maiaTopCpLoss < 100) return null;
  const trapNag = nagForMaiaTrap(maiaTopCpLoss);
  return {
    uci: maiaTopUci,
    color: 'red',
    nag: trapNag != null ? [trapNag] : undefined,
  };
}

/**
 * Главная функция модуля — для каждого полухода считает Annotation.
 */
export function buildAnnotation(input: MoveInput): Annotation {
  const nag = pickNag(input);

  const variations: AnnotationVariation[] = [];
  const green = maybeGreenVariation(input, nag);
  if (green) variations.push(green);
  const red = maybeRedVariation(input);
  if (red) variations.push(red);
  // §4.3: максимум 2 — уже гарантировано (один green + один red).

  return {
    ply: input.ply,
    nag: nag != null ? [nag] : [],
    variations,
  };
}

/** Batch helper для удобства caller'а. */
export function buildAnnotations(inputs: readonly MoveInput[]): Annotation[] {
  return inputs.map(buildAnnotation);
}
