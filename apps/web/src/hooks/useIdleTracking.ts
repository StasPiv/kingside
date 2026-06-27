import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { track } from '../lib/events';

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
];

export interface UseIdleTrackingOptions {
  /** Первый порог простоя, сек. По умолчанию 30. */
  idleSec?: number;
  /** Интервал повторных событий простоя, сек. По умолчанию 60. */
  repeatSec?: number;
}

/**
 * KS-4684 / ADR-147 §2.1 — событие `session_idle` при простое
 * пользователя.
 *
 * Первое событие шлётся через `idleSec` (по умолчанию 30 сек) без
 * активности; затем каждые `repeatSec` сек (по умолчанию 60), пока
 * пользователь молчит. На любой активности (`mousemove`, `keydown`,
 * `touchstart`, `scroll`, `visibilitychange`) таймер сбрасывается.
 *
 * Гейт по consent — внутри `track()`, дополнительная проверка не
 * нужна.
 */
export function useIdleTracking(opts?: UseIdleTrackingOptions): void {
  const idleSec = opts?.idleSec ?? 30;
  const repeatSec = opts?.repeatSec ?? 60;
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let firstTimeout: ReturnType<typeof setTimeout> | null = null;
    let repeatInterval: ReturnType<typeof setInterval> | null = null;
    let idleStart = Date.now();

    const clearAll = () => {
      if (firstTimeout) {
        clearTimeout(firstTimeout);
        firstTimeout = null;
      }
      if (repeatInterval) {
        clearInterval(repeatInterval);
        repeatInterval = null;
      }
    };

    const emitIdle = () => {
      const seconds = Math.round((Date.now() - idleStart) / 1000);
      track('session_idle', { page: pathRef.current, idle_seconds: seconds });
    };

    const startIdleCycle = () => {
      clearAll();
      idleStart = Date.now();
      firstTimeout = setTimeout(() => {
        emitIdle();
        repeatInterval = setInterval(emitIdle, repeatSec * 1000);
      }, idleSec * 1000);
    };

    const onActivity = () => {
      startIdleCycle();
    };

    startIdleCycle();
    ACTIVITY_EVENTS.forEach((ev) => {
      window.addEventListener(ev, onActivity, { passive: true });
    });
    // `visibilitychange` живёт на document — добавляем отдельно, чтобы
    // переключение вкладки тоже считалось активностью.
    document.addEventListener('visibilitychange', onActivity);

    return () => {
      clearAll();
      ACTIVITY_EVENTS.forEach((ev) => {
        window.removeEventListener(ev, onActivity);
      });
      document.removeEventListener('visibilitychange', onActivity);
    };
  }, [idleSec, repeatSec]);
}
