import type { ReactNode } from 'react';

import { useLazyMount } from '../../hooks/useLazyMount';

/**
 * `<LazySection>` — обёртка для секций «ниже сгиба» на /lessons
 * (KS-1924, ADR-031 §4.2). До первого пересечения с `rootMargin`
 * рендерит `fallback` (skeleton того же размера, без layout-shift),
 * после — `children` (реальный блок с собственным fetch-ом).
 *
 * Атрибут `data-lazy-state="pending|mounted"` на корневом div'е
 * полезен для тестов / скриншотов прогрессивной загрузки.
 */
interface LazySectionProps {
  children: ReactNode;
  fallback: ReactNode;
  rootMargin?: string;
  testId?: string;
  className?: string;
}

export function LazySection({
  children,
  fallback,
  rootMargin,
  testId,
  className,
}: LazySectionProps) {
  const { ref, visible } = useLazyMount<HTMLDivElement>({ rootMargin });
  return (
    <div
      ref={ref}
      className={className}
      data-testid={testId}
      data-lazy-state={visible ? 'mounted' : 'pending'}
    >
      {visible ? children : fallback}
    </div>
  );
}
