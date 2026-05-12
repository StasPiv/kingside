import { useEffect, useState } from 'react';

/**
 * KS-2841 (ADR-058 §11.2 вариант D, §11.7).
 *
 * Возвращает текущий тип указателя:
 *   - `'fine'`   — мышь / trackpad / стилус с точным позиционированием;
 *   - `'coarse'` — палец (touch).
 *
 * Источник правды — CSS media-query `(pointer: fine)`. Браузеры
 * выбирают значение по primary-input, и при подключении/отключении
 * мыши значение `matches` динамически меняется (через listener
 * `change`).
 *
 * **Не путать с `useIsMobile`.** Тот отдаёт `true`/`false` на основании
 * viewport-ширины и `(hover: none)` — фокус на «mobile/desktop UX
 * profile». `usePointerType` — про конкретный physical-input *прямо
 * сейчас*. На гибриде (Surface, iPad+Magic Keyboard) viewport может
 * быть mobile-узкий, а pointer уже `fine` — мы хотим включить hover-
 * поповер именно по этому критерию (см. ADR §11.2 вариант D).
 *
 * SSR-fallback: `'fine'` (desktop default; `window.matchMedia`
 * недоступен — мы не падаем).
 */

export type PointerType = 'fine' | 'coarse';

const QUERY = '(pointer: fine)';

function detect(): PointerType {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'fine';
  }
  return window.matchMedia(QUERY).matches ? 'fine' : 'coarse';
}

export function usePointerType(): PointerType {
  const [type, setType] = useState<PointerType>(() => detect());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setType(e.matches ? 'fine' : 'coarse');
    };
    // Safari < 14 не поддерживает addEventListener на MQL — fallback.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler as (e: MediaQueryListEvent) => void);
      return () => {
        mql.removeEventListener(
          'change',
          handler as (e: MediaQueryListEvent) => void,
        );
      };
    }
    type Legacy = { addListener: (fn: (e: MediaQueryListEvent) => void) => void; removeListener: (fn: (e: MediaQueryListEvent) => void) => void };
    const legacy = mql as unknown as Legacy;
    if (typeof legacy.addListener === 'function') {
      legacy.addListener(handler as (e: MediaQueryListEvent) => void);
      return () => {
        legacy.removeListener(handler as (e: MediaQueryListEvent) => void);
      };
    }
  }, []);

  return type;
}
