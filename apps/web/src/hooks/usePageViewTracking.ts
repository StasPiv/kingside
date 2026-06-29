import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { track } from '../lib/events';

// KS-4787 diag: маркер на уровне модуля — печатается ровно один раз, когда
// модуль реально импортирован bundler'ом. Если этой строки нет в stdout, а
// `[ks-diag bootstrap]` есть — значит EventsBootstrap взял из bundle устаревшую
// (закэшированную HMR) версию модуля без новых логов.
// eslint-disable-next-line no-console
console.log('[ks-diag pageView] module loaded rev=2');

/**
 * KS-4684 / ADR-147 §2.1 — событие `page_view` на каждую смену маршрута.
 *
 * Подписывается на `useLocation()` и при изменении `pathname` шлёт
 * `track('page_view', { path, prev_path })`. Если consent не дан или
 * клиент не сконфигурирован — `track` сам no-op'нет.
 *
 * Поведение для user и guest одинаково: backend различает actor по
 * JWT/cookie (§2.2).
 *
 * KS-4787: параметр `ready` (по умолчанию `true`) — гейт на готовность
 * consent и инициализации `configureEvents()`. Пока `ready=false`
 * хук не считает текущий pathname «отправленным» — `sentForPathRef`
 * обновляется только после реального вызова `track`. При смене
 * `ready` с false на true (auth.me пришёл, consent появился) — будет
 * выслан `page_view` для текущего pathname. Дублей нет: для одного
 * pathname `track` вызывается ровно один раз.
 */
export function usePageViewTracking(ready: boolean = true): void {
  const location = useLocation();
  const sentForPathRef = useRef<string | null>(null);

  // KS-4787 diag: лог в теле хука (до useEffect). Если этой строки нет —
  // значит хук вообще не вызывается из EventsBootstrap (либо ранний return
  // выше по дереву, либо EventsBootstrap не смонтирован).
  // eslint-disable-next-line no-console
  console.log(
    `[ks-diag pageView] hook called: ready=${ready} pathname=${location.pathname}`,
  );

  useEffect(() => {
    // KS-4787 diag: временный лог для e2e — убрать после зелёного прогона.
    // eslint-disable-next-line no-console
    console.log(
      `[ks-diag pageView] effect: ready=${ready} pathname=${location.pathname} sent=${sentForPathRef.current}`,
    );
    if (!ready) return;
    const path = location.pathname;
    const prev = sentForPathRef.current;
    // Не шлём событие при no-op rerender'ах и повторных переходах
    // в тот же pathname (например, после прихода consent).
    if (prev === path) return;
    // eslint-disable-next-line no-console
    console.log(`[ks-diag pageView] track('page_view', {path:${path}})`);
    track('page_view', { path, prev_path: prev });
    sentForPathRef.current = path;
  }, [location.pathname, ready]);
}
