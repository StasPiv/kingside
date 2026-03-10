import { useEffect, useState, type RefObject } from 'react';

/**
 * Tracks the content width of a container element via ResizeObserver.
 * Returns 0 until the element is mounted and measured.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(el);
    setWidth(el.clientWidth);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}
