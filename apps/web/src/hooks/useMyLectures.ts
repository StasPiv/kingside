import { useCallback, useEffect, useRef, useState } from 'react';
import type { LectureStatus, LectureSummary } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * KS-3966 / ADR-119 §8 эпик B (шаг B01). Хук-обёртка над
 * эндпоинтом `GET /my/lectures` (ADR-118 KS-3937).
 *
 * Backend возвращает лекции пользователя по двум основаниям:
 *  - сам пользователь — `ownerId === user.id`;
 *  - пользователю предоставлен доступ через `LectureAccessGrant`
 *    (allowlist).
 *
 * Контракт ответа: `{ items, total, hasMore }`. `items` — массив
 * `LectureSummary`. Сортировку и пагинацию определяет backend;
 * фронт лишь пробрасывает `limit/offset` и накапливает страницы.
 *
 * Поведение хука:
 *  - Каждое значимое изменение фильтров (`status`/`limit`) сбрасывает
 *    накопленный список и стартует с `offset=0`.
 *  - `loadMore()` загружает следующую страницу с
 *    `offset = items.length`, добавляет в конец. Игнорируется, пока
 *    предыдущий запрос ещё в полёте, либо когда `hasMore === false`.
 *  - `refetch()` принудительно перезапускает базовый запрос (для
 *    обновлений после mutate-операций — например, после отмены
 *    лекции владельцем).
 *  - Защита от устаревших ответов через `seqRef`-counter.
 *  - При HTTP 401/403 — `error: 'forbidden'`, при 404 — `'not-found'`,
 *    при прочих — `'load-failed'`. На `loadMore` ошибка не очищает
 *    уже накопленный список — пользователь видит, что то, что
 *    успело загрузиться, осталось.
 */

export type MyLecturesError = 'forbidden' | 'not-found' | 'load-failed';

export interface UseMyLecturesFilters {
  /**
   * Фильтр по статусу. `'all'` (или отсутствие) — без фильтра.
   * Backend whitelist'ит значения `LectureStatus`.
   */
  status?: LectureStatus | 'all';
  /** Размер страницы. Backend по умолчанию ставит 20; здесь — 20. */
  limit?: number;
}

export interface UseMyLecturesState {
  items: LectureSummary[];
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: MyLecturesError | null;
  loadMore: () => void;
  refetch: () => void;
}

interface MyLecturesResponse {
  items: LectureSummary[];
  total: number;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;

function buildQuery(filters: UseMyLecturesFilters, offset: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? DEFAULT_LIMIT));
  params.set('offset', String(offset));
  if (filters.status && filters.status !== 'all') {
    params.set('status', filters.status);
  }
  return params.toString();
}

function mapError(e: unknown): MyLecturesError {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return 'forbidden';
    if (e.status === 404) return 'not-found';
  }
  return 'load-failed';
}

export function useMyLectures(
  filters: UseMyLecturesFilters = {},
): UseMyLecturesState {
  const [items, setItems] = useState<LectureSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<MyLecturesError | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // KS-2149 паттерн: seq-guard. Каждый новый фильтр или ручной
  // refetch инкрементирует счётчик; ответы с устаревшим mySeq
  // игнорируются.
  const seqRef = useRef(0);
  // Текущее реально использованное число загруженных элементов —
  // нужно `loadMore`, чтобы посчитать `offset` без замыкания через
  // state. Обновляем в той же микрозадаче, что и `setItems`.
  const itemsLengthRef = useRef(0);

  // Стабильная сериализация значимых полей. JSON.stringify тут
  // дёшев — у фильтра два поля.
  const filtersKey = JSON.stringify({
    status: filters.status,
    limit: filters.limit,
  });

  useEffect(() => {
    const mySeq = ++seqRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setItems([]);
    itemsLengthRef.current = 0;
    setTotal(null);
    setHasMore(false);

    api
      .get<MyLecturesResponse>(`/my/lectures?${buildQuery(filters, 0)}`)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        const next = res.items ?? [];
        setItems(next);
        itemsLengthRef.current = next.length;
        setTotal(typeof res.total === 'number' ? res.total : null);
        setHasMore(Boolean(res.hasMore));
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        setError(mapError(e));
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, reloadTick]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const mySeq = ++seqRef.current;
    setLoadingMore(true);
    const offset = itemsLengthRef.current;
    api
      .get<MyLecturesResponse>(`/my/lectures?${buildQuery(filters, offset)}`)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        const next = res.items ?? [];
        setItems((prev) => {
          const merged = [...prev, ...next];
          itemsLengthRef.current = merged.length;
          return merged;
        });
        setTotal(typeof res.total === 'number' ? res.total : total);
        setHasMore(Boolean(res.hasMore));
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        // На `loadMore` ошибка не сбрасывает уже накопленный список —
        // покажем индикатор ошибки, оставив прежние items видимыми.
        setError(mapError(e));
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadingMore, hasMore, filters, total]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return {
    items,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    refetch,
  };
}
