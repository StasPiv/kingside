import { useEffect, useState } from 'react';

/**
 * KS-3112: debounce-обёртка над значением. Возвращает версию `value`,
 * которая обновляется только если новое значение продержалось `delay`
 * мс. При новом обновлении таймер сбрасывается.
 *
 * Полезно для UI с быстрыми кликами (`+`/`-` MultiPV): state источника
 * обновляется немедленно (optimistic UI — пользователь видит новое
 * значение в инпуте мгновенно), а зависимый эффект (отправка UCI-команд
 * в engine) идёт через debounced-версию — engine получает только
 * финальное значение.
 *
 * Очищает таймер на unmount и при изменении value/delay.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
