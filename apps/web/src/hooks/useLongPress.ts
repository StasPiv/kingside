import { useCallback, useEffect, useRef } from 'react';

/**
 * KS-3198: long-press с авто-повтором.
 *
 * Использование на навигационных кнопках (← / → / ⇤ / ⇥), чтобы при
 * удержании ходы пролистывались автоматически — иначе пользователю
 * приходится много раз тапать (жалоба в /tmp/telegram/326129898_0.jpg).
 *
 * Контракт:
 *   - `pointerdown` запускает таймер `warmUpDelay` (защита от обычного
 *     tap'а — если пользователь отпустил до warm-up, отрабатывает только
 *     одиночный `onClick` стандартной кнопки, наш хук не дёргает action).
 *   - После warm-up вызывается `onAction` сразу + setInterval с
 *     `tickInterval`.
 *   - `pointerup` / `pointercancel` / `pointerleave` / blur (на всякий
 *     случай) — останавливает повтор и сбрасывает таймер.
 *   - `disabled` гасит ВСЁ: и warm-up, и активный repeat. Если кнопка
 *     стала `disabled` в процессе repeat (например, дошли до конца
 *     партии), повтор останавливается мгновенно.
 *
 * Возвращает props, которые надо разложить на `<button {...props}>`.
 * onClick стандартной кнопки НЕ перехватывается — он по-прежнему
 * срабатывает для обычного tap'а (≤ warmUpDelay), что даёт правильное
 * UX: короткое нажатие = один шаг, длинное = авто-повтор.
 *
 * Pointer events используются вместо mouse/touch — это единый API,
 * корректно работает на mobile / desktop / стилус (требование задачи
 * §4: «не использовать mousedown напрямую»).
 *
 * Haptic feedback (vibrate) опциональный — включается флагом `haptic`.
 * vibrate(8) на каждый tick даёт лёгкую отдачу на Android (iOS Safari
 * `navigator.vibrate` не реализует — gracefully ignored через optional
 * chaining).
 */
export interface UseLongPressOptions {
  /**
   * Действие — то, что делает обычный onClick (например `gotoNext`).
   * Будет вызвано на КАЖДОМ tick'е авто-повтора.
   */
  onAction: () => void;
  /**
   * Задержка перед началом авто-повтора, мс. Короткий tap (< warmUpDelay)
   * наш хук не дёргает — стандартный onClick кнопки сам отработает.
   * Default: 350ms.
   */
  warmUpDelay?: number;
  /**
   * Интервал между авто-tick'ами, мс. Default: 150ms (≈7 ходов/сек).
   */
  tickInterval?: number;
  /**
   * Если true — авто-повтор не запускается. Используется для кнопок
   * `←`/`→`, у которых `disabled` означает «доехали до начала/конца».
   * При смене флага в true во время активного repeat — останавливается.
   */
  disabled?: boolean;
  /**
   * Лёгкая вибрация (Android) на каждом tick'е авто-повтора. Default: false.
   */
  haptic?: boolean;
}

export interface UseLongPressProps {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLElement>) => void;
}

export function useLongPress({
  onAction,
  warmUpDelay = 350,
  tickInterval = 150,
  disabled = false,
  haptic = false,
}: UseLongPressOptions): UseLongPressProps {
  // Сохраняем последнюю версию onAction в ref, чтобы setInterval всегда
  // звал актуальную замыкание (без перезапуска интервала). Без ref'а
  // пришлось бы класть onAction в deps useCallback ниже, и каждый
  // ререндер пересоздавал бы props (см. KS-2598 паттерн).
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  const warmUpRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (warmUpRef.current !== null) {
      window.clearTimeout(warmUpRef.current);
      warmUpRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Когда disabled становится true в процессе active repeat — гасим
  // немедленно, чтобы повтор не «пробил» за конец партии. На false →
  // ничего не запускаем (запуск только от pointerdown).
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  // Cleanup на unmount — без него интервал «переживёт» компонент и
  // вызовет onAction уже отмонтированного элемента.
  useEffect(() => stop, [stop]);

  const start = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (disabled) return;
      // Только основная кнопка мыши / palm-touch / стилус. Right-click,
      // средняя кнопка и т.п. — игнорим (нативное контекстное меню
      // должно работать как раньше).
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      stop();
      warmUpRef.current = window.setTimeout(() => {
        warmUpRef.current = null;
        // Первый tick сразу после warm-up, дальше — каждые tickInterval.
        actionRef.current();
        if (haptic) navigator.vibrate?.(8);
        intervalRef.current = window.setInterval(() => {
          if (disabled) {
            stop();
            return;
          }
          actionRef.current();
          if (haptic) navigator.vibrate?.(8);
        }, tickInterval);
      }, warmUpDelay);
    },
    [disabled, haptic, stop, tickInterval, warmUpDelay],
  );

  return {
    onPointerDown: start,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onBlur: stop,
  };
}
