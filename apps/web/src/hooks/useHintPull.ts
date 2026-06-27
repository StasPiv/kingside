import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { HintShowPayload } from '@kingside/shared';

const API_BASE =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

const PULL_INTERVAL_MS = 15_000;
const IDLE_PULL_MS = 30_000;

export interface UseHintPullOptions {
  /** `false` для авторизованных (там WS) либо при отсутствии consent. */
  enabled: boolean;
  /** Получен payload от GET /hints/pending — передать в HintHost. */
  onHint: (payload: HintShowPayload) => void;
  /** Подмена fetch для тестов. */
  fetchImpl?: typeof fetch;
}

/**
 * KS-4703 / ADR-147 §4.1. Pull-loop для гостей: каждые 15 сек дёргает
 * `GET /hints/pending` (cookie `guest_id`). Дополнительный внеочередной
 * запрос при смене route и при 30 сек простоя. Throttle на стороне
 * сервера — 6/мин/cookie (см. `HintsController.cookieThrottle`).
 *
 * `enabled=false` → no-op (для авторизованных или без consent). При
 * смене `enabled→true` loop стартует с нулевой задержкой первого тика.
 */
export function useHintPull(opts: UseHintPullOptions): void {
  const { enabled, onHint, fetchImpl } = opts;
  const fetchRef = useRef(fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined));
  fetchRef.current = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const onHintRef = useRef(onHint);
  onHintRef.current = onHint;
  const inflightRef = useRef(false);
  const location = useLocation();

  const pull = useCallback(async () => {
    if (!enabled) return;
    const f = fetchRef.current;
    if (!f) return;
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await f(`${API_BASE}/hints/pending`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return;
      for (const item of data) {
        if (item && typeof item === 'object' && 'hintId' in item) {
          onHintRef.current(item as HintShowPayload);
        }
      }
    } catch {
      // Сеть — молчим, следующий тик попробует.
    } finally {
      inflightRef.current = false;
    }
  }, [enabled]);

  // Периодический pull + первый запрос при включении.
  useEffect(() => {
    if (!enabled) return;
    void pull();
    const id = setInterval(() => void pull(), PULL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, pull]);

  // Внеочередной pull на смену route.
  useEffect(() => {
    if (!enabled) return;
    void pull();
  }, [location.pathname, enabled, pull]);

  // Внеочередной pull при простое 30 сек.
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void pull(), IDLE_PULL_MS);
    };
    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'scroll',
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [enabled, pull]);
}
