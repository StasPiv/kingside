import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { track } from '../lib/events';

/**
 * KS-4684 / ADR-147 §2.1 — событие `page_view` на каждую смену маршрута.
 *
 * Подписывается на `useLocation()` и при изменении `pathname` шлёт
 * `track('page_view', { path, prev_path })`. Если consent не дан или
 * клиент не сконфигурирован — `track` сам no-op'нет.
 *
 * Поведение для user и guest одинаково: backend различает actor по
 * JWT/cookie (§2.2).
 */
export function usePageViewTracking(): void {
  const location = useLocation();
  const prevPathRef = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;
    const prev = prevPathRef.current;
    // Не шлём событие при no-op rerender'ах (тот же путь).
    if (prev === path) return;
    track('page_view', { path, prev_path: prev });
    prevPathRef.current = path;
  }, [location.pathname]);
}
