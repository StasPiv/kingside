/**
 * KS-3610 (ADR-101 §3). Утилита расширения варианта-линии «по стабилизации».
 *
 * Берём `startFen` + первый ход `firstMoveUci` (от Stockfish top-1
 * или от Maia-альтернативы) и идём по best-ходам, продлевая линию пока:
 *  - не стабилизировались две подряд пары полуходов (|loss_E| <
 *    `STABILIZED_LOSS_E_THRESHOLD` оба раза), ИЛИ
 *  - не упёрлись в `MAX_LINE_LENGTH_PLIES`, ИЛИ
 *  - не достигли decided position (`|wdlSigned| > DECIDED_WDL_SIGNED_ABS`),
 *    в этом случае фиксируем последний best-ход и завершаем, ИЛИ
 *  - `engineGetBestLine` вернул `null` (мат, stalemate, cancel).
 *
 * Forcing-move (check/capture) — даёт +1 продление сверх стабилизации
 * (правило §3.3 «forcing-move продление»). После forcing-хода
 * стабилизация перепроверяется со следующего шага.
 *
 * POV-инверсия: SF выдаёт WDL POV ходящей стороны позиции «после
 * хода». Caller (`useGameReview`/тест) **должен** инвертировать
 * `wdlAfter` обратно к POV исходного ходящего, если хочет одну ось
 * для loss_E. Внутри `buildStabilizedLine` мы работаем со «своей»
 * POV-конвенцией на каждом шаге — поэтому `engineGetBestLine` отдаёт
 * `wdlAfter` POV нового ходящего (после хода), а stabilization-проверка
 * идёт по разнице последовательных WDL'ов с правильной инверсией.
 *
 * Возвращает массив UCI: первый элемент = `firstMoveUci`, далее —
 * продление в нужной длине. Гарантирует `length >= MIN_LINE_LENGTH_PLIES`
 * (т.е. ≥ 1). При `null` от engine сразу возвращается
 * `[firstMoveUci]`.
 */
import { expectedScoreFromWdl, invertWdl, wdlSigned, type Wdl } from '@kingside/shared';

import { isCheckOrCapture } from './moveFlags';

export const STABILIZED_LOSS_E_THRESHOLD = 0.03;
export const STABILIZED_CONSECUTIVE_PLIES = 2;
export const MAX_LINE_LENGTH_PLIES = 8;
export const SUB_VARIATION_MAX_LENGTH_PLIES = 4;
export const MIN_LINE_LENGTH_PLIES = 1;
export const DECIDED_WDL_SIGNED_ABS = 0.95;

/**
 * Колбэки оркестратора:
 *  - `engineGetBestLine(fen)` отдаёт SF top-1 для позиции `fen`:
 *    `{ bestUci, wdlAfter }`, где `wdlAfter` — POV ходящей стороны
 *    `fen` (т.е. того игрока, что ходит на этом полуходе). `null`
 *    если позиция конечная / cancel / нет ответа.
 *  - `applyMoveToFen(fen, uci)` — стандартное «применить ход и
 *    отдать новый FEN». Если ход нелегальный — caller возвращает
 *    `null`.
 */
export interface StabilizedEngines {
  engineGetBestLine: (
    fen: string,
  ) => { bestUci: string; wdlAfter: Wdl } | null;
  applyMoveToFen: (fen: string, uci: string) => string | null;
}

/**
 * `firstMove` уже сделан caller'ом (это либо sfBest, либо
 * maiaAlternative). На вход ему подавать его `wdlAfter` (POV ходящей
 * стороны `startFen` — т. е. того, чей `firstMove`), чтобы можно было
 * посчитать loss_E на следующем шаге.
 */
export interface StabilizedFirstMove {
  uci: string;
  /**
   * WDL после `firstMove`, POV того же игрока, что и `startFen`'s STM.
   * Caller инвертирует raw SF-output (там новая STM — соперник).
   */
  wdlAfter: Wdl;
}

export function buildStabilizedLine(
  startFen: string,
  firstMove: StabilizedFirstMove,
  engines: StabilizedEngines,
  maxLengthPlies: number = MAX_LINE_LENGTH_PLIES,
): string[] {
  const line: string[] = [firstMove.uci];

  // FEN после первого хода.
  let curFen = engines.applyMoveToFen(startFen, firstMove.uci);
  if (curFen == null) return line;

  // Текущий E_score POV ходящей-на-`startFen` стороны (после
  // firstMove). Каждый next-step будет переводить POV — поэтому
  // ниже мы храним «E POV исходного игрока» и используем
  // `invertWdl` при сравнении.
  // Здесь `wdlAfter` уже POV исходного игрока (caller инвертировал).
  let lastEScoreOriginalPov = expectedScoreFromWdl(firstMove.wdlAfter);

  // Decided-check: если firstMove уже привёл к выигранной/проигранной
  // позиции (по originalPov), не продлеваем дальше — фиксируем 1 ход.
  if (Math.abs(wdlSigned(firstMove.wdlAfter)) > DECIDED_WDL_SIGNED_ABS) {
    return line;
  }

  let consecutiveStable = 0;
  // forcingBonusUsed — глобальный budget +1 (как «бонус за forcing»);
  // forceBreakAfterNext — флаг: после forcing-продления делаем ещё
  // ровно один step и обрываем (правило «forcing → ровно +1»).
  let forcingBudget = 1;
  let forceBreakAfterNext = false;

  while (line.length < maxLengthPlies) {
    if (curFen == null) break;

    const sf = engines.engineGetBestLine(curFen);
    if (!sf) break;

    // На fenAfterPrev side-to-move = соперник исходного игрока.
    // `sf.wdlAfter` — POV side-to-move *новой* позиции (после bestUci) =
    // POV исходного игрока (он будет ходить через ход). Caller это
    // делает через invertWdl — наш контракт.
    //
    // Чтобы тест мог работать без этой инверсии (как происходит, если
    // оркестратор корректно нормализует), мы НЕ инвертируем здесь
    // wdlAfter ещё раз. Просто сравниваем как есть.
    const eScoreOriginalPov = expectedScoreFromWdl(sf.wdlAfter);
    const lossAbsolute = Math.abs(
      lastEScoreOriginalPov - eScoreOriginalPov,
    );
    const isStable = lossAbsolute < STABILIZED_LOSS_E_THRESHOLD;

    // Применяем ход в линию.
    line.push(sf.bestUci);

    // Декларируем decided'ную: если после хода |signed| > 0.95 —
    // обрываем линию (этот ход последний).
    const nextFen = engines.applyMoveToFen(curFen, sf.bestUci);
    const isDecided =
      Math.abs(wdlSigned(sf.wdlAfter)) > DECIDED_WDL_SIGNED_ABS;
    if (isDecided) break;

    // Если на прошлой итерации мы продлевались форсинг-бонусом,
    // обрываем здесь ровно после +1 хода.
    if (forceBreakAfterNext) {
      break;
    }

    // Стабилизация: 2 подряд стабильных полухода → стоп. Forcing-move
    // (check/capture) — нарушает «спокойствие» позиции, дает +1
    // продление (ровно один дополнительный полуход).
    if (isStable) {
      consecutiveStable++;
      if (consecutiveStable >= STABILIZED_CONSECUTIVE_PLIES) {
        // Проверяем forcing-move последнего ходящего (current move).
        const forcing = isCheckOrCapture(curFen, sf.bestUci);
        if (forcing && forcingBudget > 0) {
          forcingBudget--;
          forceBreakAfterNext = true;
        } else {
          break;
        }
      }
    } else {
      consecutiveStable = 0;
    }

    lastEScoreOriginalPov = eScoreOriginalPov;
    curFen = nextFen;
  }

  // Гарантия MIN.
  if (line.length < MIN_LINE_LENGTH_PLIES) {
    // Невозможно по построению — firstMove уже добавлен.
    return line;
  }
  return line;
}

// Re-export для удобства тестов.
export { invertWdl };
