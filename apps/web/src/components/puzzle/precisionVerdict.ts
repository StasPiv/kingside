import type { PuzzleObjective } from '@kingside/shared';
import type { WdlDistribution } from '../../utils/engineAdapter';

/**
 * KS-2955: вердикт «преимущество удержано / потеряно» для precision-режима.
 *
 * Раньше logic'а опиралась исключительно на абсолютный знак WDL после
 * хода юзера (`effWdlUser < failThreshold`). Это давало ложные lose для
 * валидных задач, где исходная позиция уже была проиграна для решателя,
 * но в разборе юзер сыграл лучший возможный ход (Qxf7+! при -1.15 для
 * белых: ход помечен `!`, а UI говорил «преимущество потеряно»).
 *
 * Контекст для верных бизнес-правил precision: задача — это сценарий
 * «удержать преимущество», но даже валидно сгенерированные задачи могут
 * содержать линии, где лучший ход всё равно не возвращает преимущество в
 * плюс (например, технически выигрышная для соперника позиция после
 * единственно правильного защитного хода). В таких случаях ход должен
 * квалифицироваться как «удержан» (точнее — не как «потерян»).
 *
 * Правило фикса:
 *  1. Если фактический ход юзера совпал с лучшим в позиции
 *     (`playedUci === bestUci`, сравниваем from+to без учёта promotion-
 *     суффикса), то «потеряно» НЕ ставится — это идеальная игра.
 *  2. Иначе — старая логика по абсолютному `failThreshold`.
 *
 * Helper чистый, без side-эффектов, тестируется отдельно (см.
 * `precisionVerdict.test.ts`).
 */
export interface PrecisionVerdictSnapshot {
  /** UCI лучшего хода из движка для позиции до хода (PV1). */
  bestUci: string;
  /** UCI фактического хода юзера. */
  playedUci: string;
}

/**
 * KS-2968: порог допустимого падения win% (промилле) между стартовым
 * baseline и финальным WDL для квалификации «преимущество удержано».
 * 150 ‰ = 15 п.п. — допускаем небольшие просадки от движка
 * (1-10 п.п. — естественный noise SF между depth/movetime), но падение
 * на 15+ п.п. больше уже квалифицируется как потеря преимущества,
 * даже если по абсолютному WDL раннер остался формально в плюсе
 * (winThreshold).
 */
export const PRESERVED_WIN_DROP_THRESHOLD_PERMILLE = 150;

/**
 * KS-2968: квалификатор «преимущество потеряно» по дельте win%
 * baseline → final. Дополнение к `shouldFinishLose` и проверке
 * `effWdl >= winThreshold`: даже если итоговая позиция формально в
 * выигрышной зоне по signed-WDL, но win% упал относительно стартового
 * baseline сильнее порога — это потеря преимущества.
 *
 * Реальный кейс (KS-2968, скриншот пользователя): start=92/8/0,
 * final=50/50/0. signed-WDL финала ≈ 0.5 — на границе winThreshold,
 * UI ставил «удержано». Но падение win% на 42 п.п. — очевидная
 * потеря, плашка должна стать «потеряно».
 *
 * @param start baseline WDL перед началом партии (`clientBaselineWdl`,
 *   либо серверный `puzzle.playVsEngine.wdlAfter` как fallback). Если
 *   `null`/`undefined` — функция возвращает `false` (нет baseline —
 *   старая логика без drop-проверки).
 * @param final WDL POV user'а после финального полухода. Если
 *   `null`/`undefined` — функция возвращает `false`.
 * @param thresholdPermille допустимое падение win в промилле
 *   (default 150 = 15 п.п.).
 * @returns `true`, если падение win превышает порог → «потеряно».
 */
export function isWinDropExcessive(
  start: WdlDistribution | null | undefined,
  final: WdlDistribution | null | undefined,
  thresholdPermille = PRESERVED_WIN_DROP_THRESHOLD_PERMILLE,
): boolean {
  if (!start || !final) return false;
  const drop = start.w - final.w;
  return drop > thresholdPermille;
}

/**
 * @param snapshot snapshot текущего user-хода (см. `UserBestSnapshot`)
 *   или `null`, если pre-analyze ещё не дописал данные (тогда фолбэк
 *   на абсолютный порог).
 * @param effWdlUser эффективный signed-WDL POV юзера после фактического
 *   хода (см. `effectiveSignedWdl`). Диапазон [-1..+1].
 * @param failThreshold абсолютный порог «потери» из параметров задачи.
 * @param objective жанр пазла (KS-3248): для `saveEquality` функция
 *   ВСЕГДА возвращает `false`. Причина — `failThreshold` сравнивает
 *   с абсолютным signed-WDL, а в saveEquality стартовый baseline уже
 *   близок к нулю или даже отрицательный (сторона защищает ничью из
 *   проигрышной позиции). Любой промежуточный полуход легко попадает
 *   под `effWdl < failThreshold` и пазл закрывается как `lose-wdl`
 *   ПОСЛЕ ПЕРВОГО ХОДА, не дав сыграть серию (см. /tmp/telegram/
 *   326129994_0.jpg — 26... Nxe4, верный ход, runner выкинул). Финал
 *   saveEquality решает только `meetsFinalObjective` в конце серии.
 *   Если `objective` не передан или `convertAdvantage` — старое поведение.
 */
export function shouldFinishLose(
  snapshot: PrecisionVerdictSnapshot | null,
  effWdlUser: number,
  failThreshold: number,
  objective: PuzzleObjective | null | undefined = null,
): boolean {
  // KS-3248: saveEquality — финал считается через meetsFinalObjective,
  // никогда не fail'имся по «промежуточному» effWdl < failThreshold.
  if (objective === 'saveEquality') return false;
  if (snapshot && uciSquares(snapshot.playedUci) === uciSquares(snapshot.bestUci)) {
    // Юзер сыграл лучший ход из доступных — даже если позиция объективно
    // проиграна, «потерянного» хода нет.
    return false;
  }
  return effWdlUser < failThreshold;
}

/**
 * KS-3169 (ADR-070): финальный успех решателя зависит от жанра пазла.
 *
 * До этого тикета все три финальные точки в `PlayVsEngineRunner`
 * (userMovesTarget, halfMovesN, last-user-move) сравнивали `effWdlUser`
 * с `winThreshold` и считали успехом «формально в выигрышной зоне».
 * Для `saveEquality` (спасение в ничью) этот критерий неверен: ничейный
 * финал `(w≈0, d≈1000, l≈0)` даёт signed≈0, что < `winThreshold=0.5`,
 * — и идеально удержанная ничья квалифицировалась как `lose-wdl`. Внешне
 * это проявлялось как звук «неправильно» поверх блока «Ничья удержана
 * идеально» (5★ от `PrecisionScoreBlock`, который интерпретирует score
 * через accuracy-loss и не зависит от win/lose-вердикта).
 *
 * Правило (согласовано с `meetsSolvabilityFinal` из shared
 * `puzzle-gen-core.ts`):
 *  - `convertAdvantage` / `undefined` — `signed >= winThreshold` (старое
 *    поведение, без регрессии для исторических пазлов).
 *  - `saveEquality` — `(W + D) / 1000 >= winThreshold` (суммарная
 *    не-проигрышная доля). Если `wdlObj` не пришёл (engine не отдал
 *    distribution), fallback на `signed >= -winThreshold` — т.е. «не
 *    скатился глубоко в минус».
 *
 * `dropTooHigh` (KS-2968) — отдельный признак потери преимущества по
 * Δwin% относительно baseline. Для saveEquality он бессмысленен (baseline
 * уже близкий к 0 по win), и применять его нельзя — иначе любая ничья
 * с положительным стартовым win% выпадет в lose. В вызывающем коде
 * `dropTooHigh` должен зануляться для saveEquality.
 *
 * @param wdlObj  W/D/L POV solver'а на финальной позиции (если есть).
 * @param effWdl  signed WDL POV solver'а в [-1..+1] (fallback при отсутствии wdlObj).
 * @param objective жанр пазла (`convertAdvantage` / `saveEquality` / `null`).
 * @param winThreshold порог из `params.winThreshold` (по умолчанию 0.5).
 */
export function meetsFinalObjective(
  wdlObj: WdlDistribution | null | undefined,
  effWdl: number,
  objective: PuzzleObjective | null | undefined,
  winThreshold: number,
): boolean {
  if (objective === 'saveEquality') {
    if (wdlObj) {
      return (wdlObj.w + wdlObj.d) / 1000 >= winThreshold;
    }
    // Fallback без W/D/L: «не проиграл по signed». Симметричный порог
    // вокруг нуля — `-winThreshold` (для winThreshold=0.5 это -0.5,
    // что соответствует доле не-проигрыша ≥ 50% при равных W и D).
    return effWdl >= -winThreshold;
  }
  // convertAdvantage и legacy (objective undefined) — старая логика.
  return effWdl >= winThreshold;
}

/**
 * Нормализует UCI к виду `<from><to>` без promotion-суффикса —
 * `onPieceDrop` собирает `playedUci = source+target` без 'q', а
 * `bestUci` из engine может содержать 5 символов (`e7e8q`). Сравнение
 * без суффикса безопасно для precision: promotion внутри runner'а
 * жёстко авто-ферзь, никаких альтернатив фигур нет.
 */
function uciSquares(uci: string): string {
  return uci.slice(0, 4);
}

/**
 * KS-4028: какой именно звуковой ивент проиграть как итоговый.
 *
 * Источник истины — `verdictKey` от shared `computeVerdictKey(stars,
 * objectiveAchieved)`, та же функция что использует сервер при подсчёте
 * `PrecisionAttempt`. Звук и плашка в UI получают идентичный ключ —
 * рассогласования больше нет.
 *
 * Правило (матрица 5×2 verdictKey → звук):
 *  - верхний ряд (цель достигнута): `flawless`, `confident`, `suboptimal`,
 *    `with-mistakes`, `with-blunders` → `puzzle-correct`;
 *  - нижний ряд (цель не достигнута): `goal-missed-clean`, `goal-missed`,
 *    `goal-missed-mistakes`, `goal-missed-blunders` → `puzzle-incorrect`.
 *
 * Особый случай 5★ (`flawless`): по defensive-fallback в `computeVerdictKey`
 * 5★ всегда даёт `flawless` независимо от `objectiveAchieved` — это
 * совпадает с UI-правилом `isEffectivelySolved` в истории попыток
 * (KS-3173: `solved || score===5`), который тоже считает 5★ успехом
 * даже при `solved=false`.
 *
 * `verdictKey=null` — данных недостаточно для расчёта (`stars=null`):
 * fallback на бинарный исход раннера (`'win'` → `puzzle-correct`,
 * `'lose'` → `puzzle-incorrect`).
 */
export type FinishSoundOutcome = 'win' | 'lose';

export type FinishSoundEvent = 'puzzle-correct' | 'puzzle-incorrect';

const SUCCESS_VERDICT_KEYS: ReadonlySet<string> = new Set([
  'flawless',
  'confident',
  'suboptimal',
  'with-mistakes',
  'with-blunders',
]);

export function chooseFinishSound(
  verdictKey: string | null,
  fallbackOutcome: FinishSoundOutcome,
): FinishSoundEvent {
  if (verdictKey === null) {
    return fallbackOutcome === 'win' ? 'puzzle-correct' : 'puzzle-incorrect';
  }
  return SUCCESS_VERDICT_KEYS.has(verdictKey)
    ? 'puzzle-correct'
    : 'puzzle-incorrect';
}
