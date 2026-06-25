/**
 * KS-4654 / ADR-144 §3.6 — планировщик метронома часов при низком
 * времени.
 *
 * Хук вызывает `playSound('clock-tick')` по интервалу, зависящему от
 * `urgency`:
 *   - `low`      → 1000 мс (как у lichess).
 *   - `critical` → 500 мс  (более частый ритм для бомбы).
 *   - `normal`   → не тикает.
 *
 * Тик слышен **только на своих часах** (lichess-семантика): пропс
 * `isSelfActive` должен совпасть с «это мой цвет и сейчас мой ход».
 * Подключается в `GamePage` (live) и `LocalBotGamePage` (бот). На
 * `BroadcastLiveGamePage`/`WatchGamePage` намеренно не подключается
 * (ADR §2: «зритель смотрит несколько досок — метрономы перекроются»).
 *
 * Mute и unlocked-состояние AudioContext (KS-2703) живут внутри
 * `useSounds`. Здесь они не дублируются — `playSound` сам выходит no-op
 * при mute или suspended-ctx.
 */
import { useEffect } from 'react';
import { useSounds } from './useSounds';
import type { ClockUrgency } from '../utils/formatGameClock';

export interface UseClockTickSchedulerOptions {
  /** Текущая срочность по часам активной стороны (из `useGameClockDisplay`). */
  urgency: ClockUrgency;
  /**
   * `true` когда это часы **самого пользователя**, и сейчас его ход
   * (т.е. часы тикают именно ему). `false` для часов соперника, для
   * наблюдателя, для status != 'active'.
   */
  isSelfActive: boolean;
}

/**
 * KS-4654 / ADR-144 §3.6. Период тика по urgency. `null` — не тикаем.
 */
function tickPeriodMs(urgency: ClockUrgency): number | null {
  if (urgency === 'critical') return 500;
  if (urgency === 'low') return 1000;
  return null;
}

export function useClockTickScheduler(
  options: UseClockTickSchedulerOptions,
): void {
  const { urgency, isSelfActive } = options;
  const { playSound } = useSounds();
  const period = isSelfActive ? tickPeriodMs(urgency) : null;

  useEffect(() => {
    if (period == null) return;
    const id = setInterval(() => {
      playSound('clock-tick');
    }, period);
    return () => clearInterval(id);
  }, [period, playSound]);
}
