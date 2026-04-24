import { useCallback, useEffect, useRef } from 'react';

/**
 * Debounced-обёртка над callback. Возвращает функцию, которая откладывает
 * реальный вызов на `delay` мс; повторный запуск — сбрасывает таймер.
 *
 * Внутри хранит актуальный callback в ref, чтобы замыкание не устаревало
 * между рендерами (важно для автосейв-сценариев: каждое нажатие обновляет
 * state, но таймер должен дождаться тишины и выполнить последнюю версию).
 *
 * Очищает таймер на unmount — чтобы после размонтирования не выстрелило
 * на несуществующем компоненте.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number,
): (...args: Args) => void {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    },
    [delay],
  );
}
