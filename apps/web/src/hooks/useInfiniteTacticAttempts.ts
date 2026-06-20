/**
 * KS-4359 / ADR-136 §3.8. Cursor-пагинация для
 * `GET /tactic-puzzles/attempts` — история попыток текущего пользователя.
 *
 * Архитектура повторяет `useInfiniteTacticPuzzles`:
 *   - `seq-guard` через монотонный счётчик отсекает гонки на смене
 *     фильтров;
 *   - `lastUsedCursorRef` блокирует повторный запрос на тот же cursor;
 *   - `AbortController` отменяет запрос в полёте при смене фильтра.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TacticAttemptListItem } from '@kingside/shared';
import { ApiError } from '../ApiError';
import {
  tacticPuzzleApi,
  type ListTacticAttemptsQuery,
} from '../api/api-tactic-puzzle';

export interface InfiniteTacticAttemptsState {
  attempts: TacticAttemptListItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  removeLocally: (id: string) => void;
  patchLocally: (id: string, patch: Partial<TacticAttemptListItem>) => void;
}

function buildFiltersKey(filters: ListTacticAttemptsQuery): string {
  return JSON.stringify({
    from: filters.from,
    to: filters.to,
    stopReason: filters.stopReason,
    solved: filters.solved,
    ratingMin: filters.ratingMin,
    ratingMax: filters.ratingMax,
    limit: filters.limit,
  });
}

export function useInfiniteTacticAttempts(
  filters: ListTacticAttemptsQuery,
): InfiniteTacticAttemptsState {
  const [attempts, setAttempts] = useState<TacticAttemptListItem[]>([]);
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
    setAttempts([]);
    setNextCursor(null);

    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const isAborted = (e: unknown): boolean =>
      (e instanceof ApiError &&
        e.errorCode === 'REQUEST_TIMEOUT' &&
        signal.aborted) ||
      (e instanceof DOMException && e.name === 'AbortError');

    tacticPuzzleApi
      .listAttempts(filters, null, signal)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setAttempts(res.items ?? []);
        setNextCursor(res.nextCursor ?? null);
        cursorRef.current = res.nextCursor ?? null;
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        setError(
          e instanceof Error ? e.message : 'Failed to load attempts',
        );
        setAttempts([]);
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
      .listAttempts(filters, cursorAtCall)
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setAttempts((prev) => [...prev, ...(res.items ?? [])]);
        const nextC =
          res.nextCursor && res.nextCursor !== cursorAtCall
            ? res.nextCursor
            : null;
        setNextCursor(nextC);
        cursorRef.current = nextC;
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        setError(
          e instanceof Error ? e.message : 'Failed to load attempts',
        );
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoadingMore(false);
      });
  }, [filters, loadingMore]);

  const removeLocally = useCallback((id: string) => {
    setAttempts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const patchLocally = useCallback(
    (id: string, patch: Partial<TacticAttemptListItem>) => {
      setAttempts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

  return {
    attempts,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    removeLocally,
    patchLocally,
  };
}
