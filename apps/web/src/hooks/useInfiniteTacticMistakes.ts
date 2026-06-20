/**
 * KS-4362 / ADR-136 T10. Cursor-пагинация для
 * `GET /tactic-puzzles/mistakes` — журнал нерешённых ошибок текущего
 * пользователя. Архитектура повторяет `useInfiniteTacticAttempts`:
 * seq-guard, lastUsedCursorRef, AbortController.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TacticMistakeListItem } from '@kingside/shared';
import { ApiError } from '../ApiError';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

export interface InfiniteTacticMistakesState {
  mistakes: TacticMistakeListItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  removeLocally: (puzzleId: string) => void;
  patchLocally: (
    puzzleId: string,
    patch: Partial<TacticMistakeListItem>,
  ) => void;
}

export function useInfiniteTacticMistakes(
  limit = 30,
): InfiniteTacticMistakesState {
  const [mistakes, setMistakes] = useState<TacticMistakeListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const lastUsedCursorRef = useRef<string | null>(null);

  useEffect(() => {
    const mySeq = ++seqRef.current;
    cursorRef.current = null;
    lastUsedCursorRef.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMistakes([]);
    setNextCursor(null);

    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const isAborted = (e: unknown): boolean =>
      (e instanceof ApiError &&
        e.errorCode === 'REQUEST_TIMEOUT' &&
        signal.aborted) ||
      (e instanceof DOMException && e.name === 'AbortError');

    tacticPuzzleApi
      .listMistakes(null, limit, signal)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setMistakes(res.items ?? []);
        setNextCursor(res.nextCursor ?? null);
        cursorRef.current = res.nextCursor ?? null;
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        setError(e instanceof Error ? e.message : 'Failed to load mistakes');
        setMistakes([]);
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
  }, [limit]);

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
      .listMistakes(cursorAtCall, limit)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setMistakes((prev) => [...prev, ...(res.items ?? [])]);
        const nextC =
          res.nextCursor && res.nextCursor !== cursorAtCall
            ? res.nextCursor
            : null;
        setNextCursor(nextC);
        cursorRef.current = nextC;
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load mistakes');
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoadingMore(false);
      });
  }, [limit, loadingMore]);

  const removeLocally = useCallback((puzzleId: string) => {
    setMistakes((prev) => prev.filter((m) => m.puzzleId !== puzzleId));
  }, []);

  const patchLocally = useCallback(
    (puzzleId: string, patch: Partial<TacticMistakeListItem>) => {
      setMistakes((prev) =>
        prev.map((m) => (m.puzzleId === puzzleId ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  return {
    mistakes,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    removeLocally,
    patchLocally,
  };
}
