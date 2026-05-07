import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * KS-2561 / KS-2560 (backend): cursor pagination для `/puzzles/browse`.
 * Эндпоинт возвращает `{ data, nextCursor }`; cursor — base64({c, i}).
 * Сортировка фиксированная (`created_at DESC, id DESC`), параметры
 * `offset/sort/order` удалены.
 *
 * Хук — упрощённая версия `ArchiveGamesPage` infinite-логики:
 * `seq-guard` (монотонный счётчик) защищает от race'ов при смене
 * фильтров; `nextCursor === null` означает «достигли конца».
 */

export interface BrowsePuzzleDto {
  id: string;
  fen: string;
  moves: string[] | string;
  rating: number;
  themes: string[] | string;
  source: string;
  /** KS-2493+: API маркер solution-режима. Опционально на /browse. */
  solutionMode?: 'forced-line' | 'play-vs-engine';
  sourceId: string | null;
  sourceMoveNum: number | null;
  sourceMetadata: { white?: string; black?: string; event?: string } | null;
  isPublic?: boolean;
  userId?: string;
  createdAt: string;
  solvedStatus?: 'solved' | 'failed' | null;
}

interface BrowseResponse {
  data: BrowsePuzzleDto[];
  nextCursor: string | null;
}

export interface InfinitePuzzleFilters {
  /** Опциональный нижний порог рейтинга. */
  ratingMin?: number;
  /** Опциональный верхний порог рейтинга. */
  ratingMax?: number;
  /** Темы (ANY-of). Пустой массив = без фильтра по теме. */
  themes?: string[];
  /** Только мои пазлы. */
  mine?: boolean;
  /** Скрыть уже решённые. */
  hideSolved?: boolean;
  /**
   * Какой источник пазлов брать. Без значения — backend отдаёт все
   * (после KS-2557 hotfix).
   */
  source?: string;
  /**
   * KS-2582 / KS-2586: фильтр по `is_public`. `'draft'` = только
   * `is_public=false`; `'public'` = только `is_public=true`; `'all'`
   * (или undefined) = без фильтра. Backend whitelist'ит значения.
   */
  visibility?: 'draft' | 'public' | 'all';
  /** Размер страницы. По умолчанию 30. */
  limit?: number;
}

export interface InfinitePuzzlesState {
  puzzles: BrowsePuzzleDto[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** `true` пока сервер прислал не `null` в `nextCursor`. */
  hasMore: boolean;
  /** Запросить следующую страницу. Игнорируется, если `hasMore=false`. */
  loadMore: () => void;
  /** Удаляет пазл из локального состояния (после backend `DELETE`). */
  removeLocally: (id: string) => void;
  /** Обновляет одно поле локально (например `isPublic` после PATCH). */
  patchLocally: (id: string, patch: Partial<BrowsePuzzleDto>) => void;
}

function buildQuery(
  filters: InfinitePuzzleFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 30));
  if (cursor) params.set('cursor', cursor);
  if (filters.ratingMin != null)
    params.set('ratingMin', String(filters.ratingMin));
  if (filters.ratingMax != null)
    params.set('ratingMax', String(filters.ratingMax));
  if (filters.themes && filters.themes.length > 0)
    params.set('themes', filters.themes.join(','));
  if (filters.mine) params.set('mine', 'true');
  if (filters.hideSolved) params.set('hideSolved', 'true');
  if (filters.source) params.set('source', filters.source);
  if (filters.visibility) params.set('visibility', filters.visibility);
  return params.toString();
}

export function useInfinitePuzzles(
  filters: InfinitePuzzleFilters,
): InfinitePuzzlesState {
  const [puzzles, setPuzzles] = useState<BrowsePuzzleDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // KS-2149-pattern: seq-guard. Каждое новое требование (init / loadMore)
  // увеличивает счётчик; ответы со старыми seq игнорируются.
  const seqRef = useRef(0);
  // Последний actual cursor — нужен для loadMore без замыкания state.
  const cursorRef = useRef<string | null>(null);
  /**
   * KS-2565: cursor, с которым мы УЖЕ делали запрос. Защищает от
   * бесконечного цикла retry, когда retry-effect в `PuzzleBrowserPage`
   * после `loadingMore: true → false` снова видит sentinel в viewport
   * и дёргает `loadMore`. Если backend в гонке вернул тот же cursor
   * (что произошло в проде, 16+ запросов подряд) — мы будем фечить
   * бесконечно. Идемпотентность: повторный fetch с тем же cursor —
   * no-op, hasMore переключается в false.
   */
  const lastUsedCursorRef = useRef<string | null>(null);

  // Стабильная сериализация фильтров — изменения значимых полей
  // вызывают перезагрузку. JSON-сериализация массива тем сохраняет
  // порядок, что норм (порядок выбора пользователя).
  const filtersKey = JSON.stringify({
    ratingMin: filters.ratingMin,
    ratingMax: filters.ratingMax,
    themes: filters.themes,
    mine: filters.mine,
    hideSolved: filters.hideSolved,
    source: filters.source,
    visibility: filters.visibility,
    limit: filters.limit,
  });

  // Initial / reset on filters change.
  useEffect(() => {
    const mySeq = ++seqRef.current;
    cursorRef.current = null;
    // KS-2565: при смене фильтра — разрешаем заново все cursor'ы.
    lastUsedCursorRef.current = null;
    setLoading(true);
    setError(null);
    setPuzzles([]);
    setNextCursor(null);
    api
      .get<BrowseResponse>(
        `/puzzles/browse?${buildQuery(filters, null)}`,
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles(res.data ?? []);
        setNextCursor(res.nextCursor ?? null);
        cursorRef.current = res.nextCursor ?? null;
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load puzzles');
        setPuzzles([]);
        setNextCursor(null);
        cursorRef.current = null;
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadMore = useCallback(() => {
    const cursorAtCall = cursorRef.current;
    if (!cursorAtCall) return;
    if (loadingMore) return;
    // KS-2565: если уже фечили с этим cursor (например, retry-effect
    // вызвал нас дважды подряд, или backend вернул тот же cursor что
    // мы посылали) — больше не пытаемся, переключаем hasMore=false.
    if (cursorAtCall === lastUsedCursorRef.current) {
      cursorRef.current = null;
      setNextCursor(null);
      return;
    }
    lastUsedCursorRef.current = cursorAtCall;
    const mySeq = ++seqRef.current;
    setLoadingMore(true);
    api
      .get<BrowseResponse>(
        `/puzzles/browse?${buildQuery(filters, cursorAtCall)}`,
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles((prev) => [...prev, ...(res.data ?? [])]);
        // KS-2565: если backend вернул тот же cursor что мы послали —
        // прогресса нет, считаем, что список закончился.
        const nextC =
          res.nextCursor && res.nextCursor !== cursorAtCall
            ? res.nextCursor
            : null;
        setNextCursor(nextC);
        cursorRef.current = nextC;
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load puzzles');
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoadingMore(false);
      });
  }, [filters, loadingMore]);

  const removeLocally = useCallback((id: string) => {
    setPuzzles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const patchLocally = useCallback(
    (id: string, patch: Partial<BrowsePuzzleDto>) => {
      setPuzzles((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
    },
    [],
  );

  return {
    puzzles,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    removeLocally,
    patchLocally,
  };
}
