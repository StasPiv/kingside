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

  /** PV первой линии Stockfish (массив UCI). Используется как fallback
   *  для green-subline когда `sfBestSubline` не задан (KS-3603). */
  sfBestPv: string[];
  /**
   * KS-3610 (ADR-101 §4.1): готовый stabilized subline для green-
   * вариации (от `buildStabilizedLine(fenAfterSfBest, sfBest, …)`).
   * Если задан — используется он вместо `sfBestPv.slice(1, 3)`.
   * Длина обычно 1..7 полуходов (после первого хода `sfBestUci`).
   */
  sfBestSubline?: string[];
  /**
   * KS-3610 (ADR-101 §4.2 v2): готовый stabilized subline для
   * red-вариации (от `buildStabilizedLine(fenAfterMaiaTop, maiaTop,
   * …, cap=4)`). Если задан — используется он. Длина обычно
   * 1..3 полухода.
   */
  maiaTopSubline?: string[];

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
  /**
   * KS-3619. Один position-eval NAG (11/14-19) на финальной позиции
   * ветки. Ставится перед `{[%cvc <color>]}` в PGN-выводе.
   */
  finalEvalNag?: number;
  /**
   * KS-3610 (ADR-101 §4.2 v2). Вложенные variations на каждом полуходе
   * этой ветки. Длина массива = 1 + (subline?.length ?? 0). Индекс
   * `i = 0` — variations на `uci` (первый ход), `i = N+1` — variations
   * на `subline[N]`. Пустой массив на конкретном индексе означает «нет
   * вложений». Не задан целиком — ветка не обрабатывалась нестед-
   * билдером (legacy / тесты).
   */
  nestedVariations?: AnnotationVariation[][];
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

// --- KS-3619 position-eval NAG (PGN 10-19) ---------------------------------

export const NAG_EVAL_EQUAL = 11; // =
export const NAG_EVAL_SLIGHT_WHITE = 14; // ⩲
export const NAG_EVAL_SLIGHT_BLACK = 15; // ⩱
export const NAG_EVAL_MODERATE_WHITE = 16; // ±
export const NAG_EVAL_MODERATE_BLACK = 17; // ∓
export const NAG_EVAL_DECISIVE_WHITE = 18; // +−
export const NAG_EVAL_DECISIVE_BLACK = 19; // −+

/**
 * KS-3619. По WDL финальной позиции возвращает один position-eval
 * NAG из набора 11/14-19.
 *
 * `wdlStmPov` — WDL POV side-to-move на финальной позиции (то есть
 * того игрока, который БУДЕТ ходить в этой позиции — это конвенция
 * Stockfish с `UCI_ShowWDL=true`).
 *
 * `stmIsWhite` — `true` если на ход белые в финальной позиции.
 *
 * Пороги (по `E_white = stmIsWhite ? E : 1−E`, `E = (w + d/2)/1000`):
 *   |Δ| < 0.05 → 11 (=)
 *   0.05 ≤ Δ < 0.15 → 14 (⩲), Δ ≤ −0.05 симметрично → 15 (⩱)
 *   0.15 ≤ Δ < 0.35 → 16 (±), симметрично → 17 (∓)
 *   Δ ≥ 0.35 → 18 (+−), симметрично → 19 (−+)
 */
export function pickFinalEvalNag(
  wdlStmPov: Wdl,
  stmIsWhite: boolean,
): number {
  const E = (wdlStmPov.w + wdlStmPov.d / 2) / 1000;
  const eWhite = stmIsWhite ? E : 1 - E;
  const d = eWhite - 0.5;
  if (Math.abs(d) < 0.05) return NAG_EVAL_EQUAL;
  if (d >= 0.35) return NAG_EVAL_DECISIVE_WHITE;
  if (d >= 0.15) return NAG_EVAL_MODERATE_WHITE;
  if (d >= 0.05) return NAG_EVAL_SLIGHT_WHITE;
  if (d <= -0.35) return NAG_EVAL_DECISIVE_BLACK;
  if (d <= -0.15) return NAG_EVAL_MODERATE_BLACK;
  return NAG_EVAL_SLIGHT_BLACK;
}

/**
 * KS-3617. Симметричный «decided»-suppress quality-NAG.
 *
 *   До правки suppress был односторонним: если `|signed(before)| > 0.95`,
 *   NAG возвращали `null` независимо от того, что произошло после. Это
 *   маскировало упущение выигрыша: например, до хода у белых signed=1.0
 *   (выигрыш), после хода signed ≈ 0 (ничья) — ход явно `??`, но
 *   suppress гасил NAG.
 *
 *   Теперь suppress срабатывает только если позиция была decided **до**
 *   хода И осталась decided **после** в **том же направлении**
 *   (`sign(sigBefore) === sign(sigAfter)` при `|sigAfter| > threshold`).
 *   То есть подавляем шум на ходах внутри уже выигранной/проигранной
 *   позиции; не подавляем ходы, которые меняют исход.
 *
 *   Решение принято в рамках KS-3617 на основе прогона реальных партий
 *   (см. `tools/ks3617-annotate-prod.ts`). Подлежит синку в ADR-100 §3.3.
 */
const DECIDED_WDL_THRESHOLD = 0.95;

/**
 * KS-3610 (ADR-101 §4.2 v2). Минимальная Maia probability для добавления
 * red-альтернативы. По ADR-100 было 0.25; в ADR-101 расширено до 0.20
 * — больше «человеческих» альтернатив в выборку.
 */
export const MAIA_ALT_MIN_PROB = 0.2;

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
  // KS-3617: симметричный suppress. Гасим NAG только когда позиция
  // была decided до хода И осталась decided после, в одну сторону.
  // Если ход «уронил» оценку через decided-границу — NAG обязан стоять.
  const sigBefore = wdlSigned(input.wdlBefore);
  const sigAfter = wdlSigned(input.wdlAfterPlayed);
  const decidedBefore = Math.abs(sigBefore) > DECIDED_WDL_THRESHOLD;
  const decidedAfter = Math.abs(sigAfter) > DECIDED_WDL_THRESHOLD;
  const sameSide = Math.sign(sigBefore) === Math.sign(sigAfter);
  if (decidedBefore && decidedAfter && sameSide) return null;

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
    input.playedProb < BRILLIANT_MAIA_PROB_THRESHOLD &&
    !input.forcedMove &&
    (secondBestClass === 'mistake' || secondBestClass === 'blunder')
  ) {
    return NAG_BRILLIANT;
  }

  // !: played=best (PV1) И playedProb<0.10 (KS-3617: было 0.20 — это
  // вешало `!` на типовые дебютные ходы вроде `1...c5` где Maia
  // даёт ~10%. Понижено до 0.10, чтобы `!` отмечал реально
  // неочевидные ходы).
  if (
    playedClass === 'best' &&
    samePlayed &&
    input.playedProb !== undefined &&
    input.playedProb < GOOD_MAIA_PROB_THRESHOLD
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

/**
 * KS-3617: тот же порог что и для `!` в основной линии — `playedProb < 0.10`.
 * Применяется к `sfBestProb` для зелёной вариации (первый ход).
 */
const BRILLIANT_MAIA_PROB_THRESHOLD = 0.05;
const GOOD_MAIA_PROB_THRESHOLD = 0.1;

function maybeGreenVariation(
  input: MoveInput,
  playedClass: MoveClass,
): AnnotationVariation | null {
  // Зелёная вариация (SF-best) ставится на любую «не-best»-классификацию,
  // которая получает знак вопроса: ?! (inaccuracy), ? (mistake), ??
  // (blunder). До правки фильтр включал только mistake/blunder — на
  // inaccuracy вариант не появлялся, и если Maia-top совпадал с
  // SF-best (типовая ситуация — обе модели согласны), красная тоже
  // отрезалась как дубль зелёной, и ход вообще оставался без
  // альтернативы. Это закрывает кейс «4...Bg7 ?! без `(4...dxc3 …)`».
  if (
    playedClass !== 'inaccuracy' &&
    playedClass !== 'mistake' &&
    playedClass !== 'blunder'
  ) {
    return null;
  }
  if (input.sfBestUci === input.playedUci) return null;
  // KS-3610: предпочитаем stabilized subline (если caller его посчитал);
  // fallback на PV slice — для backward-compat с тестами KS-3603/3607.
  const subline = input.sfBestSubline ?? input.sfBestPv.slice(1, 3);

  // Пользовательский запрос: тот же критерий «!» что и в основной линии,
  // только применённый к SF-лучшему ходу в зелёной вариации. Если Maia
  // редко находит этот ход (`sfBestProb < 0.10`), это и есть «неочевидный
  // сильный ход» — заслуживает «!». Без этого `!` ставился только если
  // пользователь сам нашёл лучший ход, а в варианте-альтернативе шёл без
  // знака — и подсказка теряла часть информации.
  const greenNags: number[] = [];
  if (
    input.sfBestProb !== undefined &&
    input.sfBestProb < GOOD_MAIA_PROB_THRESHOLD
  ) {
    greenNags.push(NAG_GOOD);
  }

  return {
    uci: input.sfBestUci,
    color: 'green',
    subline,
    nag: greenNags.length > 0 ? greenNags : undefined,
  };
}

function maybeRedVariation(
  input: MoveInput,
  maiaTopClass: MoveClass | null,
): AnnotationVariation | null {
  if (!maiaTopClass) return null; // §4.2 skip если wdlAfterMaiaTop undefined.
  if (input.maiaTopUci === input.sfBestUci) return null;
  if (input.maiaTopUci === input.playedUci) return null;
  // KS-3610 (ADR-101 §4.2 v2): порог prob ≥ 0.20 (было 0.25).
  if (input.maiaTopProb < MAIA_ALT_MIN_PROB) return null;
  // KS-3610: classify !== 'best' (было 'mistake'|'blunder'). Это
  // расширяет покрытие: inaccuracy / good / mistake / blunder —
  // все попадают (best — нет, т.к. это не альтернатива «к лучшему»).
  if (maiaTopClass === 'best') return null;
  let nag = nagForMaiaTrap(maiaTopClass);
  // KS-3617: симметричный §3.3 — если позиция была decided до хода
  // и осталась decided после maia-альт в ту же сторону, не вешаем
  // NAG (декорация в уже выигранной/проигранной позиции — шум).
  // Если ход меняет статус — NAG остаётся.
  if (nag != null && input.wdlAfterMaiaTop) {
    const sigBefore = wdlSigned(input.wdlBefore);
    const sigAfterMaia = wdlSigned(input.wdlAfterMaiaTop);
    const decidedBefore = Math.abs(sigBefore) > DECIDED_WDL_THRESHOLD;
    const decidedAfter = Math.abs(sigAfterMaia) > DECIDED_WDL_THRESHOLD;
    const sameSide = Math.sign(sigBefore) === Math.sign(sigAfterMaia);
    if (decidedBefore && decidedAfter && sameSide) nag = null;
  }
  return {
    uci: input.maiaTopUci,
    color: 'red',
    // KS-3610: stabilized subline (cap=4 для red-variation) если есть.
    subline: input.maiaTopSubline,
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
  const nags: number[] = nag != null ? [nag] : [];

  // Пользовательский запрос: после неточности / ошибки / зевка в основной
  // линии оценка позиции изменилась — добавляем eval-NAG (=, ⩲/⩱, ±/∓,
  // +−/−+) рядом с ?!/?/??. Без этого читатель видел только сам знак
  // ошибки, но не понимал, насколько именно она поменяла оценку.
  if (
    nag === NAG_DUBIOUS ||
    nag === NAG_MISTAKE ||
    nag === NAG_BLUNDER
  ) {
    // wdlAfterPlayed уже в POV ходящей стороны (см. MoveInput-комментарии),
    // то есть POV того, кто только что сыграл. На ходу теперь противник:
    // stmAfter = !stmBefore. pickFinalEvalNag хочет POV side-to-move.
    const stmBeforeIsWhite = input.fen.split(' ')[1] !== 'b';
    const stmAfterIsWhite = !stmBeforeIsWhite;
    // wdlAfterPlayed — POV ходившего; нам нужно POV stm после хода (=
    // POV соперника). Инвертируем W↔L, чтобы pickFinalEvalNag получил
    // правильную POV.
    const wdlStmPov: Wdl = {
      w: input.wdlAfterPlayed.l,
      d: input.wdlAfterPlayed.d,
      l: input.wdlAfterPlayed.w,
    };
    nags.push(pickFinalEvalNag(wdlStmPov, stmAfterIsWhite));
  }

  // Шаг 6: variations.
  const variations: AnnotationVariation[] = [];
  const green = maybeGreenVariation(input, playedClass);
  if (green) variations.push(green);
  const red = maybeRedVariation(input, maiaTopClass);
  if (red) variations.push(red);

  return {
    ply: input.ply,
    nag: nags,
    variations,
  };
}

export function buildAnnotations(inputs: readonly MoveInput[]): Annotation[] {
  return inputs.map(buildAnnotation);
}
