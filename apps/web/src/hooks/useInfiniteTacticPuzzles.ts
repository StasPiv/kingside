/**
 * KS-4343 / ADR-135 §2.5. Cursor-пагинация для `/tactic-puzzles/browse`.
 *
 * Архитектура по образцу `useInfinitePuzzles`:
 *   - `seq-guard` через монотонный счётчик защищает от race-condition
 *     при смене фильтров;
 *   - `lastUsedCursorRef` блокирует бесконечный повторный запрос на тот же
 *     cursor (KS-2565 защита);
 *   - `AbortController` отменяет запрос в полёте при смене фильтра.
 *
 * Типы фильтров — из shared (`TacticPuzzleBrowseQuery`), общий с backend
 * (KS-4342). Имя поля сложности: `maiaDifficultyMin`, дополнительно `gapMin`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../ApiError';
import type {
  TacticPuzzleBrowseQuery,
  TacticPuzzleResponse,
} from '@kingside/shared';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

export interface InfiniteTacticPuzzlesState {
  puzzles: TacticPuzzleResponse[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  removeLocally: (id: string) => void;
  patchLocally: (id: string, patch: Partial<TacticPuzzleResponse>) => void;
}

function buildFiltersKey(filters: TacticPuzzleBrowseQuery): string {
  return JSON.stringify({
    objective: filters.objective,
    maiaDifficultyMin: filters.maiaDifficultyMin,
    gapMin: filters.gapMin,
    ratingMin: filters.ratingMin,
    ratingMax: filters.ratingMax,
    themes: filters.themes,
    // KS-4366: смена «решал/не решал/все» должна перезапросить страницу.
    solved: filters.solved,
    limit: filters.limit,
  });
}

export function useInfiniteTacticPuzzles(
  filters: TacticPuzzleBrowseQuery,
): InfiniteTacticPuzzlesState {
  const [puzzles, setPuzzles] = useState<TacticPuzzleResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const lastUsedCursorRef = useRef<string | null>(null);

  const filtersKey = buildFiltersKey(filters);

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
        setPuzzles(res.items ?? []);
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
        setPuzzles((prev) => [...prev, ...(res.items ?? [])]);
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
    (id: string, patch: Partial<TacticPuzzleResponse>) => {
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
