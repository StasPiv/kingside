/**
 * KS-3407 / ADR-086 §3 (S2). Чистая функция сравнения хода в фиче
 * «угадай ход»: ход пользователя vs реально сыгранный в партии.
 *
 * Переиспользует существующие shared-утилиты (НЕ дублирует формулы):
 *   - `wdl.ts`: `invertWdl` (POV-инверсия), `expectedScoreFromWdl` (E).
 *   - `precision-score.ts`: `accuracyMove` (Lichess accuracy от WDL).
 *   - `move-classification.ts`: `classifyMove` + `WDL_LOSS_THRESHOLDS`.
 *
 * Вход — WDL-замеры (per-mille, raw POV side-to-move каждой позиции),
 * как их отдаёт движок и присылает клиент (ADR-086 §8 server-trust).
 * Функция сама приводит WDL позиций ПОСЛЕ хода (там на ходу соперник)
 * к POV выбранной стороны через `invertWdl` — отсюда POV-инверсия
 * white/black, которую покрывают unit-тесты (§9 S2).
 *
 * Без I/O, deterministic.
 */
import { invertWdl, expectedScoreFromWdl, type Wdl } from './wdl.js';
import { accuracyMove } from './precision-score.js';
import {
  classifyMove,
  WDL_LOSS_THRESHOLDS,
  type MoveClass,
} from './move-classification.js';
import type { GuessVerdict } from '../types/api-contracts.js';

/**
 * ADR-086 §3.5. Порог «как игрок»: если |lossUser − lossPlayer| ≤ ε,
 * считаем ходы равноценными. Берём `WDL_LOSS_THRESHOLDS.best` (0.02) —
 * та же гранулярность, что отделяет `best` от `good` в classifyMove
 * (разница меньше 2 п.п. win-probability в пределах шума анализа).
 */
export const GUESS_VERDICT_EPSILON = WDL_LOSS_THRESHOLDS.best;

/**
 * WDL-замеры одного угадываемого полухода. Все — per-mille (0..1000),
 * raw POV side-to-move соответствующей позиции:
 *   - `wdlBefore` — на fenBefore ходит ВЫБРАННАЯ сторона (raw POV = она);
 *   - `wdlAfterPlayed` / `wdlAfterUser` — на fenAfter ходит СОПЕРНИК
 *     (raw POV = соперник); функция инвертирует их к POV выбранной.
 */
export interface GuessMoveEvals {
  wdlBefore: Wdl;
  wdlAfterPlayed: Wdl;
  /**
   * WDL после хода пользователя. `null`/`undefined`, если
   * `userUci === playedUci` (ход совпал — второй анализ не нужен,
   * переиспользуем `wdlAfterPlayed`, ADR-086 §3.3).
   */
  wdlAfterUser?: Wdl | null;
  /** PV1-ход движка на fenBefore (UCI) — для best-override classify. */
  bestUci: string;
}

/** Результат сравнения (POV выбранной стороны). */
export interface GuessMoveComparison {
  /** win-probability выбранной стороны ДО хода. */
  eBefore: number;
  /** win-probability после реально сыгранного хода. */
  eAfterPlayed: number;
  /** win-probability после хода пользователя. */
  eAfterUser: number;
  /** Потеря реального игрока: max(0, eBefore − eAfterPlayed). */
  lossPlayer: number;
  /** Потеря пользователя: max(0, eBefore − eAfterUser). */
  lossUser: number;
  /** accuracy% реального хода (Lichess-формула). */
  accuracyPlayer: number;
  /** accuracy% хода пользователя. */
  accuracyUser: number;
  /** Классификация хода пользователя (ADR-066). */
  userClass: MoveClass;
  /** Вердикт сравнения (ADR-086 §3.5). */
  verdict: GuessVerdict;
}

/**
 * ADR-086 §3. Сравнивает ход пользователя `userUci` с реально сыгранным
 * `playedUci` в позиции с замерами `evals`.
 *
 * Вердикт (§3.5), порядок проверок важен:
 *   1. `lossUser ≤ best-порог` → `strongest` (нашёл сильнейший).
 *   2. `lossUser < lossPlayer − ε` → `betterThanPlayer`.
 *   3. `|lossUser − lossPlayer| ≤ ε` → `asPlayer`.
 *   4. иначе → `weaker`.
 *
 * Если `userUci === playedUci` — `wdlAfterUser` можно не передавать:
 * берётся `wdlAfterPlayed`, loss/accuracy идентичны (ходы равны).
 */
export function compareGuessMove(
  playedUci: string,
  userUci: string,
  evals: GuessMoveEvals,
): GuessMoveComparison {
  const sameMove = userUci === playedUci;

  // WDL POV выбранной стороны.
  const wdlBefore = evals.wdlBefore;
  const wdlAfterPlayedPov = invertWdl(evals.wdlAfterPlayed);
  const wdlAfterUserRaw =
    sameMove || evals.wdlAfterUser == null
      ? evals.wdlAfterPlayed
      : evals.wdlAfterUser;
  const wdlAfterUserPov = invertWdl(wdlAfterUserRaw);

  const eBefore = expectedScoreFromWdl(wdlBefore);
  const eAfterPlayed = expectedScoreFromWdl(wdlAfterPlayedPov);
  const eAfterUser = expectedScoreFromWdl(wdlAfterUserPov);

  const lossPlayer = Math.max(0, eBefore - eAfterPlayed);
  const lossUser = Math.max(0, eBefore - eAfterUser);

  // accuracy — переиспуем accuracyMove (Lichess-формула от WDL POV
  // одного игрока: wdlBefore + wdlAfter, оба POV выбранной стороны).
  const accuracyPlayer =
    accuracyMove({ wdlBefore, wdlAfter: wdlAfterPlayedPov }) ?? 0;
  const accuracyUser =
    accuracyMove({ wdlBefore, wdlAfter: wdlAfterUserPov }) ?? 0;

  // classification хода пользователя. best-override если userUci===bestUci.
  const userClass = classifyMove({
    wdlBefore,
    wdlAfter: wdlAfterUserPov,
    isBestMove: userUci === evals.bestUci,
  });

  const verdict = decideVerdict(lossUser, lossPlayer);

  return {
    eBefore,
    eAfterPlayed,
    eAfterUser,
    lossPlayer,
    lossUser,
    accuracyPlayer,
    accuracyUser,
    userClass,
    verdict,
  };
}

/**
 * ADR-086 §3.5 — вердикт по двум loss-значениям.
 *
 * KS-3426: переупорядочены проверки. Раньше первая ветка
 * `lossUser ≤ ε → strongest` короткозамыкала ещё ДО сравнения с
 * реальным игроком — поэтому при дебютных топ-ходах (lossUser=0,
 * lossPlayer≈0) выдавался `strongest` вместо «равно». Сейчас сначала
 * проверяется близость к реальному ходу, и `strongest` требует, чтобы
 * пользовательский ход был идеальным И реальный ход был заметно хуже.
 *
 * Семантика:
 *  - `asPlayer`        — оба сыграли примерно одинаково (включая оба
 *                        идеальных). Приоритет.
 *  - `strongest`       — пользователь идеален И реальный заметно хуже.
 *  - `betterThanPlayer`— пользователь лучше реального, но не строго
 *                        идеален.
 *  - `weaker`          — пользователь хуже реального.
 */
export function decideVerdict(
  lossUser: number,
  lossPlayer: number,
): GuessVerdict {
  if (Math.abs(lossUser - lossPlayer) <= GUESS_VERDICT_EPSILON) return 'asPlayer';
  if (
    lossUser <= WDL_LOSS_THRESHOLDS.best &&
    lossPlayer - lossUser > GUESS_VERDICT_EPSILON
  ) {
    return 'strongest';
  }
  if (lossUser < lossPlayer - GUESS_VERDICT_EPSILON) return 'betterThanPlayer';
  return 'weaker';
}
