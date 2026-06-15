/**
 * KS-4192 / ADR-128 §7.6.1.2 L1.UI. Хук-обёртка над
 * `GET /lectures/public` со встроенным состоянием (loading / ready /
 * error). Хранит «текущий статус-фильтр» + «накопленный массив items»
 * для пагинации «Show more». При смене статуса — сбрасывает массив.
 *
 * `limit` фиксированный (по умолчанию 24 — гостевая страница, и 6 —
 * блок «Discover public lectures» в авторизованном режиме).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchPublicLectures,
  type PublicLecture,
  type PublicLectureStatusFilter,
  type PublicLecturesResponse,
} from '../api/publicLectures';

export interface UsePublicLecturesOptions {
  limit?: number;
  initialStatus?: PublicLectureStatusFilter;
}

export interface UsePublicLecturesState {
  items: PublicLecture[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: 'load_failed' | null;
  status: PublicLectureStatusFilter;
  setStatus(status: PublicLectureStatusFilter): void;
  loadMore(): void;
  reload(): void;
}

const DEFAULT_LIMIT = 24;

export function usePublicLectures(
  options: UsePublicLecturesOptions = {},
): UsePublicLecturesState {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const [status, setStatusState] = useState<PublicLectureStatusFilter>(
    options.initialStatus ?? 'all',
  );
  const [items, setItems] = useState<PublicLecture[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<'load_failed' | null>(null);

  // Защита от race: при быстрой смене статуса/«Show more» отбрасываем
  // ответы устаревших запросов.
  const reqIdRef = useRef(0);

  const fetchPage = useCallback(
    (params: { offset: number; statusFilter: PublicLectureStatusFilter; mode: 'reset' | 'append' }) => {
      const reqId = ++reqIdRef.current;
      if (params.mode === 'reset') {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      fetchPublicLectures({
        limit,
        offset: params.offset,
        status: params.statusFilter,
      })
        .then((res: PublicLecturesResponse) => {
          if (reqId !== reqIdRef.current) return;
          // Защита от неполного ответа (например, prerender-mock или
          // старая версия backend без поля items).
          const safeItems = Array.isArray(res?.items) ? res.items : [];
          if (params.mode === 'reset') {
            setItems(safeItems);
          } else {
            setItems((prev) => [...prev, ...safeItems]);
          }
          setTotal(typeof res?.total === 'number' ? res.total : safeItems.length);
          setHasMore(Boolean(res?.hasMore));
        })
        .catch(() => {
          if (reqId !== reqIdRef.current) return;
          setError('load_failed');
        })
        .finally(() => {
          if (reqId !== reqIdRef.current) return;
          if (params.mode === 'reset') setLoading(false);
          else setLoadingMore(false);
        });
    },
    [limit],
  );

  // Первая загрузка + перезапрос при смене статуса.
  useEffect(() => {
    fetchPage({ offset: 0, statusFilter: status, mode: 'reset' });
  }, [status, fetchPage]);

  const setStatus = useCallback((next: PublicLectureStatusFilter) => {
    setStatusState(next);
  }, []);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    fetchPage({ offset: items.length, statusFilter: status, mode: 'append' });
  }, [loading, loadingMore, hasMore, items.length, status, fetchPage]);

  const reload = useCallback(() => {
    fetchPage({ offset: 0, statusFilter: status, mode: 'reset' });
  }, [status, fetchPage]);

  return {
    items,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    status,
    setStatus,
    loadMore,
    reload,
  };
}
