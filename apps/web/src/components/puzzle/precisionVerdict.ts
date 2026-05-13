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
 */
export function shouldFinishLose(
  snapshot: PrecisionVerdictSnapshot | null,
  effWdlUser: number,
  failThreshold: number,
): boolean {
  if (snapshot && uciSquares(snapshot.playedUci) === uciSquares(snapshot.bestUci)) {
    // Юзер сыграл лучший ход из доступных — даже если позиция объективно
    // проиграна, «потерянного» хода нет.
    return false;
  }
  return effWdlUser < failThreshold;
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
