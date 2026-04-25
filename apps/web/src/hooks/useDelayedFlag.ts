import { useEffect, useState } from 'react';

/**
 * `useDelayedFlag` — анти-flicker для skeleton-состояний (KS-1924,
 * ADR-031 §4.2). Возвращает `true` только если `active` оставался
 * `true` непрерывно ≥ `delayMs`. Если `active` сменился на `false` до
 * истечения таймера — флаг так и не поднимется.
 *
 * Применение: `const showSkeleton = useDelayedFlag(loading, 200)` —
 * skeleton мигнёт только если данные грузятся дольше 200мс. На
 * быстром API мы вообще не показываем skeleton, избегая «вспышки».
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return show;
}
