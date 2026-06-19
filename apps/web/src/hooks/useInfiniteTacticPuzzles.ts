/**
 * KS-4343 / ADR-135 §2.5. Cursor-пагинация для `/tactic-puzzles/browse`.
 *
 * Архитектура по образцу `useInfinitePuzzles`:
 *   - `seq-guard` через монотонный счётчик защищает от race-condition
 *     при смене фильтров;
 *   - `lastUsedCursorRef` блокирует бесконечный retry на одинаковый cursor
 *     (KS-2565 проблема, описана в исходнике lichess-хука);
 *   - `AbortController` отменяет inflight-запрос при смене фильтра.
 *
 * Отличия от `useInfinitePuzzles`:
 *   - не несёт `source`/`visibility`/`blundererElo*` — у новой схемы их нет;
 *   - `objective` вместо `themes`-фильтра на жанр (более явное поле);
 *   - `minDifficulty`/`maxDifficulty` вместо `minMaiaWeakChoiceProb`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../ApiError';
import {
  tacticPuzzleApi,
  type BrowseTacticPuzzleDto,
  type TacticBrowseFilters,
} from '../api/api-tactic-puzzle';

export interface InfiniteTacticPuzzlesState {
  puzzles: BrowseTacticPuzzleDto[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** `true` пока сервер не прислал `null` в `nextCursor`. */
  hasMore: boolean;
  /** Запросить следующую страницу. No-op при `hasMore=false`. */
  loadMore: () => void;
  /** Удалить пазл локально (после backend `DELETE` / разрешения mistake). */
  removeLocally: (id: string) => void;
  /** Обновить одно поле локально (например `solvedStatus` после attempt). */
  patchLocally: (id: string, patch: Partial<BrowseTacticPuzzleDto>) => void;
}

/**
 * Стабильный сериализованный ключ фильтров — изменение значимых полей
 * вызывает перезагрузку. JSON-сериализация сохраняет порядок массивов
 * тем (порядок выбора пользователя имеет значение для UI).
 */
function buildFiltersKey(filters: TacticBrowseFilters): string {
  return JSON.stringify({
    ratingMin: filters.ratingMin,
    ratingMax: filters.ratingMax,
    themes: filters.themes,
    themesOr: filters.themesOr,
    themesAnd: filters.themesAnd,
    objective: filters.objective,
    mine: filters.mine,
    hideSolved: filters.hideSolved,
    minDifficulty: filters.minDifficulty,
    maxDifficulty: filters.maxDifficulty,
    limit: filters.limit,
  });
}

export function useInfiniteTacticPuzzles(
  filters: TacticBrowseFilters,
): InfiniteTacticPuzzlesState {
  const [puzzles, setPuzzles] = useState<BrowseTacticPuzzleDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  /**
   * Cursor, с которым УЖЕ делали запрос. Защищает от бесконечного retry,
   * когда IntersectionObserver-effect видит sentinel в viewport и дергает
   * `loadMore` повторно (KS-2565). Если backend в гонке вернул тот же
   * cursor — переключаем `hasMore=false`.
   */
  const lastUsedCursorRef = useRef<string | null>(null);

  const filtersKey = buildFiltersKey(filters);

  // Initial / reset при смене фильтров.
  useEffect(() => {
    const mySeq = ++seqRef.current;
    cursorRef.current = null;
    lastUsedCursorRef.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setPuzzles([]);
    setNextCursor(null);

    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const isAborted = (e: unknown): boolean =>
      (e instanceof ApiError &&
        e.errorCode === 'REQUEST_TIMEOUT' &&
        signal.aborted) ||
      (e instanceof DOMException && e.name === 'AbortError');

    tacticPuzzleApi
      .browse(filters, null, signal)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles(res.data ?? []);
        setNextCursor(res.nextCursor ?? null);
        cursorRef.current = res.nextCursor ?? null;
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        setError(e instanceof Error ? e.message : 'Failed to load puzzles');
        setPuzzles([]);
        setNextCursor(null);
        cursorRef.current = null;
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoading(false);
      });

    return () => {
      abortCtrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadMore = useCallback(() => {
    const cursorAtCall = cursorRef.current;
    if (!cursorAtCall) return;
    if (loadingMore) return;
    if (cursorAtCall === lastUsedCursorRef.current) {
      cursorRef.current = null;
      setNextCursor(null);
      return;
    }
    lastUsedCursorRef.current = cursorAtCall;
    const mySeq = ++seqRef.current;
    setLoadingMore(true);
    tacticPuzzleApi
      .browse(filters, cursorAtCall)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles((prev) => [...prev, ...(res.data ?? [])]);
        const nextC =
          res.nextCursor && res.nextCursor !== cursorAtCall
            ? res.nextCursor
            : null;
        setNextCursor(nextC);
        cursorRef.current = nextC;
      })
      .catch((e: unknown) => {
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
    (id: string, patch: Partial<BrowseTacticPuzzleDto>) => {
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
