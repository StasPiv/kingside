import { useEffect, useState } from 'react';

/**
 * KS-2278 (ADR-037 §3.4, E4) — детект «mobile»-устройства для решения
 * desktop popup vs mobile bottom-sheet (см. NagPalette / NagPaletteSheet).
 *
 * Mobile = touch primary + узкий viewport. Используются ОБА сигнала:
 *  - `navigator.maxTouchPoints > 0` — есть touch screen.
 *  - viewport.width <= breakpoint (по умолчанию 768px — Tailwind `md`).
 *
 * Только один сигнал недостаточен:
 *  - DevTools mobile-emulation выставляет `maxTouchPoints` без узкого
 *    viewport'а — нужен и width.
 *  - Touch-screen ноуты (`Surface`, гибридные ноуты) имеют touch, но
 *    UX-режим ожидается desktop (мышь + клавиатура primary).
 *  - Ipad в desktop-режиме без touch detection.
 *  - Чисто-viewport (узкое окно браузера на десктопе) — false-positive,
 *    юзер с мышкой не ждёт mobile sheet.
 *
 * Решение: AND обоих сигналов. Слушаем resize, чтобы переключение
 * ориентации iPad / поворот телефона не оставило старое значение.
 *
 * # SSR
 *
 * В SSR-окружении (`window` undefined) возвращаем `false` (desktop-default,
 * безопасный fallback — popup рендерится корректно везде, но swipe-to-dismiss
 * на самом мобиле не активируется до hydration; вторичная гидратация
 * за несколько ms всё равно перерендерит и привяжет touch-handlers).
 */

const DEFAULT_MOBILE_BREAKPOINT_PX = 768;

interface UseIsMobileOptions {
  /** Override viewport-breakpoint (default 768px). */
  breakpointPx?: number;
}

function detectIsMobile(breakpointPx: number): boolean {
  if (typeof window === 'undefined') return false;
  const hasTouch =
    typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const isNarrow = window.innerWidth <= breakpointPx;
  return hasTouch && isNarrow;
}

export function useIsMobile(options: UseIsMobileOptions = {}): boolean {
  const breakpointPx = options.breakpointPx ?? DEFAULT_MOBILE_BREAKPOINT_PX;
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    detectIsMobile(breakpointPx),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setIsMobile(detectIsMobile(breakpointPx));
    // Сразу пересчитываем (на случай SSR-fallback'а в init).
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [breakpointPx]);

  return isMobile;
}
