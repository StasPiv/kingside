import { useEffect, useRef, useState } from 'react';

/**
 * `useLazyMount` — наблюдает за DOM-узлом через IntersectionObserver
 * и возвращает `visible: true`, как только узел впервые попадает в
 * `rootMargin` от viewport (по умолчанию 200px). После активации
 * наблюдатель отключается — ленивый mount односторонний.
 *
 * Используется для блоков «ниже сгиба» на /lessons (KS-1924, ADR-031
 * §4.2): CurriculumPillarBlock + CommunityStripBlock — чтобы не делать
 * сетевых запросов до того, как пользователь действительно дотянется
 * до этих секций.
 *
 * Если IntersectionObserver недоступен (старые браузеры или happy-dom
 * без stub'а) — fallback включается сразу (visible=true), чтобы не
 * подвешивать UI.
 */
export interface UseLazyMountOptions {
  /** rootMargin для IntersectionObserver, по умолчанию 200px. */
  rootMargin?: string;
  /** Если IO недоступен — рендерить сразу (true) или никогда (false). */
  fallback?: boolean;
}

export function useLazyMount<T extends Element = HTMLDivElement>(
  options: UseLazyMountOptions = {},
) {
  const { rootMargin = '200px', fallback = true } = options;
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    if (
      typeof window === 'undefined' ||
      typeof window.IntersectionObserver === 'undefined'
    ) {
      setVisible(fallback);
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin, fallback]);

  return { ref, visible };
}
