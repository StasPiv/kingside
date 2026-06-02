/**
 * KS-3603 → KS-3607 (ADR-100 §3-§4). Pure-функция NAG авто-аннотации
 * партии. Метрика классификации хода — `classifyMove` из shared
 * (ADR-066): WDL-loss с mate-edge, единый источник истины с
 * precision-модулем.
 *
 * ВАЖНО (KS-3607): cp-логики тут больше нет. Старые поля `cpBefore`/
 * `cpBest`/`cpPlayed`/`secondBestCp`/`maiaTopCpLoss`/`mateBefore`
 * удалены из `MoveInput`. На вход — только Wdl-объекты (POV того же
 * игрока для всех `wdlAfter*`).
 */
import {
  classifyMove,
  wdlSigned,
  type MoveClass,
  type Wdl,
} from '@kingside/shared';

export interface MoveInput {
  /** 1-based индекс полухода. */
  ply: number;
  /** FEN до сыгранного хода. */
  fen: string;
  /** UCI сыгранного хода (`e2e4`). */
  playedUci: string;
  /** SF top-1 UCI. */
  sfBestUci: string;

  /** WDL POV ходящей стороны на `fenBefore`. */
  wdlBefore: Wdl;
  /** WDL после `playedUci`, POV того же игрока (invertWdl сделан caller'ом). */
  wdlAfterPlayed: Wdl;
  /** WDL после `sfBestUci`, POV того же игрока. */
  wdlAfterBest: Wdl;
  /** WDL после SF top-2 (для !!-критерия). `null` если позиция вынужденная. */
  wdlAfterSecondBest: Wdl | null;
  /** WDL после `maiaTopUci`. `undefined` → §4.2 red-variation skip. */
  wdlAfterMaiaTop?: Wdl;

  /** PV первой линии Stockfish (массив UCI). Для green-вариации
   *  глубиной 3 (`pv[1..2]` после sfBest). */
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
   * Forced move (см. §3.1 ADR-100): 1 легальный ход или все non-best
   * с cpLoss ≥ 300. Caller-side вычисление.
   */
  forcedMove: boolean;
}

export type VariationColor = 'green' | 'red';

export interface AnnotationVariation {
  uci: string;
  color: VariationColor;
  subline?: string[];
  nag?: number[];
}

export interface Annotation {
  ply: number;
  /** Список NAG-кодов (см. §3.2). Пустой массив = нет NAG. */
  nag: number[];
  /** ≤ 2 (см. §4.3). */
  variations: AnnotationVariation[];
}

// --- §3.2 NAG-коды ---------------------------------------------------------

export const NAG_BLUNDER = 4; // ??
export const NAG_MISTAKE = 2; // ?
export const NAG_DUBIOUS = 6; // ?!
export const NAG_INTERESTING = 5; // !?
export const NAG_GOOD = 1; // !
export const NAG_BRILLIANT = 3; // !!

/**
 * §3.3 ADR-100: `|wdlSigned(before)| > 0.95` считается «decided»
 * (выигран/проигран), quality-NAG не вешаем (как и в precision-
 * accuracy: на 99% позиции мелкие колебания — норма).
 */
const DECIDED_WDL_THRESHOLD = 0.95;

// --- helpers (NAG для §4.2 red-vararation) ---------------------------------

function nagForMaiaTrap(maiaTopClass: MoveClass): number | null {
  if (maiaTopClass === 'blunder') return NAG_BLUNDER;
  if (maiaTopClass === 'mistake') return NAG_MISTAKE;
  return null;
}

// --- core ------------------------------------------------------------------

/**
 * Выбирает NAG по таблице §3.2 ADR-100. Возвращает `null` если ни
 * одно правило не сработало или сработал suppress (§3.3).
 */
function pickNag(input: MoveInput, playedClass: MoveClass, secondBestClass: MoveClass | null): number | null {
  // §3.3 suppress.
  if (input.forcedMove) return null;
  if (Math.abs(wdlSigned(input.wdlBefore)) > DECIDED_WDL_THRESHOLD) return null;

  const samePlayed = input.playedUci === input.sfBestUci;

  // §3.2 порядок: ?? → ? → ?! → !! → ! → !?.
  if (playedClass === 'blunder') return NAG_BLUNDER;
  if (playedClass === 'mistake') return NAG_MISTAKE;
  if (playedClass === 'inaccuracy') return NAG_DUBIOUS;

  // !!: played=best И playedProb<0.05 И НЕ forced И secondBest = mistake/blunder.
  if (
    playedClass === 'best' &&
    samePlayed &&
    input.playedProb !== undefined &&
    input.playedProb < 0.05 &&
    !input.forcedMove &&
    (secondBestClass === 'mistake' || secondBestClass === 'blunder')
  ) {
    return NAG_BRILLIANT;
  }

  // !: played=best (PV1) И playedProb<0.20.
  if (
    playedClass === 'best' &&
    samePlayed &&
    input.playedProb !== undefined &&
    input.playedProb < 0.2
  ) {
    return NAG_GOOD;
  }

  // !?: good (не PV1, но достаточно близко) И played≠best И playedProb≥0.30.
  if (
    playedClass === 'good' &&
    !samePlayed &&
    input.playedProb !== undefined &&
    input.playedProb >= 0.3
  ) {
    return NAG_INTERESTING;
  }

  return null;
}

function maybeGreenVariation(
  input: MoveInput,
  playedClass: MoveClass,
): AnnotationVariation | null {
  if (playedClass !== 'mistake' && playedClass !== 'blunder') return null;
  if (input.sfBestUci === input.playedUci) return null;
  return {
    uci: input.sfBestUci,
    color: 'green',
    subline: input.sfBestPv.slice(1, 3),
  };
}

function maybeRedVariation(
  input: MoveInput,
  maiaTopClass: MoveClass | null,
): AnnotationVariation | null {
  if (!maiaTopClass) return null; // §4.2 skip если wdlAfterMaiaTop undefined.
  if (input.maiaTopUci === input.sfBestUci) return null;
  if (input.maiaTopUci === input.playedUci) return null;
  if (input.maiaTopProb < 0.25) return null;
  if (maiaTopClass !== 'mistake' && maiaTopClass !== 'blunder') return null;
  const nag = nagForMaiaTrap(maiaTopClass);
  return {
    uci: input.maiaTopUci,
    color: 'red',
    nag: nag != null ? [nag] : undefined,
  };
}

export function buildAnnotation(input: MoveInput): Annotation {
  // Шаг 1: classify сыгранного хода.
  const playedClass = classifyMove({
    wdlBefore: input.wdlBefore,
    wdlAfter: input.wdlAfterPlayed,
    isBestMove: input.playedUci === input.sfBestUci,
  });

  // Шаг 2: classify SF top-2 (для !!).
  const secondBestClass: MoveClass | null = input.wdlAfterSecondBest
    ? classifyMove({
        wdlBefore: input.wdlBefore,
        wdlAfter: input.wdlAfterSecondBest,
      })
    : null;

  // Шаг 3: classify Maia top-1 (для §4.2).
  const maiaTopClass: MoveClass | null = input.wdlAfterMaiaTop
    ? classifyMove({
        wdlBefore: input.wdlBefore,
        wdlAfter: input.wdlAfterMaiaTop,
      })
    : null;

  // Шаг 4-5: NAG.
  const nag = pickNag(input, playedClass, secondBestClass);

  // Шаг 6: variations.
  const variations: AnnotationVariation[] = [];
  const green = maybeGreenVariation(input, playedClass);
  if (green) variations.push(green);
  const red = maybeRedVariation(input, maiaTopClass);
  if (red) variations.push(red);

  return {
    ply: input.ply,
    nag: nag != null ? [nag] : [],
    variations,
  };
}

export function buildAnnotations(inputs: readonly MoveInput[]): Annotation[] {
  return inputs.map(buildAnnotation);
}
