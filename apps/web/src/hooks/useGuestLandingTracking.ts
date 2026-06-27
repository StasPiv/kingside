import { useEffect } from 'react';
import { track } from '../lib/events';

const DEFAULT_TICK_SEC = 30;

export interface UseGuestLandingTrackingOptions {
  /**
   * Только для гостя: если `true`, событие не шлётся. Передавайте
   * `Boolean(user)` — для авторизованного guest_landing_viewed не нужен.
   */
  disabled?: boolean;
  /** Интервал тикового события в секундах. По умолчанию 30. */
  tickSec?: number;
}

/**
 * KS-4684 / ADR-147 §2.1 — событие `guest_landing_viewed` для гостевых
 * правил HintsEngine (T6).
 *
 * Шлёт `guest_landing_viewed { seconds }` каждые `tickSec` секунд
 * пребывания на лендинге и финальное событие при unmount страницы.
 * Backend разлогирует actor по cookie `guest_id` (§2.2). У авторизо-
 * ванного пользователя hook должен быть выключен (`disabled=true`).
 *
 * Гейт consent — на уровне `track()`. Если cookie `analytics_consent`
 * не выставлен, ничего не уйдёт.
 */
export function useGuestLandingTracking(
  opts?: UseGuestLandingTrackingOptions,
): void {
  const disabled = opts?.disabled ?? false;
  const tickSec = opts?.tickSec ?? DEFAULT_TICK_SEC;

  useEffect(() => {
    if (disabled) return;
    if (typeof window === 'undefined') return;

    const start = Date.now();
    const interval = setInterval(() => {
      const seconds = Math.round((Date.now() - start) / 1000);
      track('guest_landing_viewed', { seconds });
    }, tickSec * 1000);

    return () => {
      clearInterval(interval);
      const seconds = Math.round((Date.now() - start) / 1000);
      if (seconds > 0) {
        track('guest_landing_viewed', { seconds });
      }
    };
  }, [disabled, tickSec]);
}
