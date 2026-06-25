import { useEffect, useRef, useState } from 'react';
import {
  computeClockUrgency,
  formatGameClock,
  type ClockMode,
  type ClockUrgency,
} from '../utils/formatGameClock';

/**
 * KS-2700 / KS-4656. Хук для отображения часов broadcast-партии.
 * Backend (KS-2699) отдаёт `whiteClockMs` / `blackClockMs` (мс на
 * момент `clockUpdatedAt`) — фронт отсчитывает локально через
 * `Date.now() - clockUpdatedAt` для активной стороны.
 *
 * KS-4656 / ADR-144 §3.4. Вывод хука дополнен `urgency` и `mode` для
 * каждой стороны: при малом времени активной стороны переключаемся
 * на десятые/сотые (ADR §3.3) и поднимаем частоту тика до rAF, чтобы
 * цифра не «прыгала». Звука тиканья здесь намеренно нет (§2 ADR:
 * зритель смотрит несколько досок, метрономы перекрылись бы).
 *
 * Логика:
 *  - Активная сторона (чей ход по `isBlackTurn`): значение =
 *    `clockMs - (now - clockUpdatedAt)`.
 *  - Неактивная: статичное `clockMs` без отсчёта; `mode` всегда
 *    `'normal'` (ADR §3.3).
 *  - Если `clockUpdatedAt === null` или один из `whiteClockMs`/
 *    `blackClockMs === null` — возвращаем `null` для обоих,
 *    рендерить таймеры не нужно.
 *  - `initialMs` (опционально) задаёт пороги urgency. Broadcast не
 *    знает TC партии (`BroadcastGameSummary` не содержит initialSec)
 *    — fallback 30_000 / 8_000 из `computeClockUrgency` достаточно
 *    для разумной подсветки последней минуты-полминуты.
 */

export interface BroadcastClockInput {
  whiteClockMs: number | null | undefined;
  blackClockMs: number | null | undefined;
  clockUpdatedAt: string | null | undefined;
  /** Чья сторона на ходу. Определяется родителем через `Chess(fen).turn()`. */
  isBlackTurn: boolean;
  /**
   * Если партия завершена, тикать не нужно (фриз на последнем известном
   * значении).
   */
  isFinished?: boolean;
  /**
   * KS-4656 / ADR-144 §3.2. Начальное время контроля в мс — нужно
   * для расчёта порогов urgency. `null` / undefined → fallback
   * (emergency1=30_000, emergency2=8_000).
   */
  initialMs?: number | null;
}

export interface BroadcastClockState {
  /** Оставшиеся миллисекунды у белых; null если данных нет. */
  whiteRemainingMs: number | null;
  /** Оставшиеся миллисекунды у чёрных; null если данных нет. */
  blackRemainingMs: number | null;
  /** true если у партии вообще есть clocks для рендера. */
  hasClocks: boolean;
  /**
   * KS-4656 / ADR-144 §3.2. Срочность по часам каждой стороны.
   * `'normal'` если нет данных (`hasClocks=false`).
   */
  whiteUrgency: ClockUrgency;
  blackUrgency: ClockUrgency;
  /**
   * KS-4656 / ADR-144 §3.3. Формат вывода для каждой стороны.
   * Неактивной — всегда `'normal'`. Активной — выбирается по urgency
   * (low → tenths, critical → hundredths).
   */
  whiteMode: ClockMode;
  blackMode: ClockMode;
}

const NEUTRAL: BroadcastClockState = {
  whiteRemainingMs: null,
  blackRemainingMs: null,
  hasClocks: false,
  whiteUrgency: 'normal',
  blackUrgency: 'normal',
  whiteMode: 'normal',
  blackMode: 'normal',
};

function urgencyToMode(
  urgency: ClockUrgency,
  isActiveAndRunning: boolean,
): ClockMode {
  if (!isActiveAndRunning) return 'normal';
  if (urgency === 'critical') return 'hundredths';
  if (urgency === 'low') return 'tenths';
  return 'normal';
}

/**
 * KS-2700 / KS-4656. Чистый расчёт состояния часов broadcast'а на
 * точку `now` (`Date.now()`). Экспортируется отдельно для unit-тестов.
 */
export function computeBroadcastClock(
  input: BroadcastClockInput,
  now: number,
): BroadcastClockState {
  const {
    whiteClockMs,
    blackClockMs,
    clockUpdatedAt,
    isBlackTurn,
    isFinished,
    initialMs,
  } = input;
  if (
    whiteClockMs == null ||
    blackClockMs == null ||
    !clockUpdatedAt
  ) {
    return NEUTRAL;
  }
  const updatedAtMs = new Date(clockUpdatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    return NEUTRAL;
  }
  const elapsed = isFinished ? 0 : Math.max(0, now - updatedAtMs);
  const whiteRemainingMs = isBlackTurn
    ? whiteClockMs
    : Math.max(0, whiteClockMs - elapsed);
  const blackRemainingMs = isBlackTurn
    ? Math.max(0, blackClockMs - elapsed)
    : blackClockMs;

  const effectiveInitial = initialMs ?? null;
  const whiteUrgency = computeClockUrgency(whiteRemainingMs, effectiveInitial);
  const blackUrgency = computeClockUrgency(blackRemainingMs, effectiveInitial);

  const isWhiteRunning = !isFinished && !isBlackTurn;
  const isBlackRunning = !isFinished && isBlackTurn;

  return {
    whiteRemainingMs,
    blackRemainingMs,
    hasClocks: true,
    whiteUrgency,
    blackUrgency,
    whiteMode: urgencyToMode(whiteUrgency, isWhiteRunning),
    blackMode: urgencyToMode(blackUrgency, isBlackRunning),
  };
}

function tickStrategy(state: BroadcastClockState): 'interval' | 'raf' {
  if (state.whiteUrgency !== 'normal') return 'raf';
  if (state.blackUrgency !== 'normal') return 'raf';
  return 'interval';
}

/**
 * KS-2700 / KS-4656 / ADR-144 §3.4. Хук-обёртка над
 * `computeBroadcastClock`. Стратегия частоты:
 *  - Оба `urgency='normal'` → `setInterval(250)` — четверть секунды
 *    достаточно, цифра не «отстаёт».
 *  - Хоть один `low|critical` → `requestAnimationFrame` — десятые/
 *    сотые бегут плавно.
 *  - Без `hasClocks` или `isFinished` → таймер не запускается.
 *
 * Раньше использовался фиксированный `setInterval(1000)`. После
 * KS-4656 стратегия совпадает с `useGameClockDisplay` из KS-4652.
 */
export function useBroadcastClock(
  input: BroadcastClockInput,
): BroadcastClockState {
  const nowFn = (): number => Date.now();
  const [state, setState] = useState<BroadcastClockState>(() =>
    computeBroadcastClock(input, nowFn()),
  );

  const inputRef = useRef(input);
  inputRef.current = input;

  // Пересчёт при любом изменении входа.
  useEffect(() => {
    setState(computeBroadcastClock(inputRef.current, nowFn()));
  }, [
    input.whiteClockMs,
    input.blackClockMs,
    input.clockUpdatedAt,
    input.isBlackTurn,
    input.isFinished,
    input.initialMs,
  ]);

  const strategy = tickStrategy(state);

  useEffect(() => {
    // Партия завершена / нет данных — таймер не нужен.
    if (input.isFinished) return;
    if (
      input.whiteClockMs == null ||
      input.blackClockMs == null ||
      !input.clockUpdatedAt
    ) {
      return;
    }

    let rafId: number | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = (): void => {
      setState(computeBroadcastClock(inputRef.current, nowFn()));
    };

    if (strategy === 'raf') {
      const loop = (): void => {
        tick();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      intervalId = setInterval(tick, 250);
    }

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      if (intervalId != null) clearInterval(intervalId);
    };
  }, [
    strategy,
    input.whiteClockMs,
    input.blackClockMs,
    input.clockUpdatedAt,
    input.isFinished,
  ]);

  return state;
}

/**
 * KS-2700 / KS-4656. Совместимый wrapper над `formatGameClock` для
 * старых call-site'ов, которые передают только `remainingMs` без
 * `mode`. Возвращает `null` если `remainingMs == null` (не рендерить
 * вообще), иначе — стандартный `mm:ss` / `H:MM:SS`.
 *
 * Новые места рендера (KS-4656) должны звать `formatGameClock(ms,
 * mode)` напрямую, чтобы получать десятые/сотые при `low`/`critical`.
 */
export function formatBroadcastClock(
  remainingMs: number | null,
  mode: ClockMode = 'normal',
): string | null {
  if (remainingMs == null) return null;
  return formatGameClock(remainingMs, mode);
}
