import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchiveBucket,
  ArchiveGameColor,
  ArchiveGameResult,
  ArchiveGamesByPositionItem,
  ArchiveGamesByPositionResponse,
  ArchiveGamesSort,
} from '@kingside/shared';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001') as string;
const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

export interface UseArchiveGamesByPositionFilters {
  bucket?: ArchiveBucket;
  sort?: ArchiveGamesSort;
  minElo?: number;
  since?: string;
  result?: ArchiveGameResult;
  color?: ArchiveGameColor;
  move?: string;
  player?: string;
  eco?: string;
}

export interface UseArchiveGamesByPositionResult {
  items: ArchiveGamesByPositionItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totalApprox: number;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  refetch: () => void;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  return headers;
}

function buildParams(
  fen: string,
  filters: UseArchiveGamesByPositionFilters,
  cursor: string | null,
): URLSearchParams {
  const params = new URLSearchParams({ fen });
  if (filters.bucket) params.set('bucket', filters.bucket);
  if (filters.sort) params.set('sort', filters.sort);
  if (typeof filters.minElo === 'number') params.set('minElo', String(filters.minElo));
  if (filters.since) params.set('since', filters.since);
  if (filters.result) params.set('result', filters.result);
  if (filters.color && filters.color !== 'any') params.set('color', filters.color);
  if (filters.move) params.set('move', filters.move);
  if (filters.player) params.set('player', filters.player);
  if (filters.eco) params.set('eco', filters.eco);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return params;
}

function serializeKey(fen: string, f: UseArchiveGamesByPositionFilters): string {
  return [
    fen,
    f.bucket ?? '',
    f.sort ?? '',
    f.minElo ?? '',
    f.since ?? '',
    f.result ?? '',
    f.color ?? '',
    f.move ?? '',
    f.player ?? '',
    f.eco ?? '',
  ].join('|');
}

/**
 * Queries the archive games-by-position endpoint for a given FEN with
 * debounce, abort, and infinite-scroll pagination.
 *
 * - 300ms debounce on filter/fen changes before firing the first page.
 * - Any in-flight request is aborted when `fen`/filters change.
 * - `loadMore()` fetches the next page using `nextCursor` (no debounce).
 * - `refetch()` resets state and re-queries the first page.
 *
 * See ADR-014 §6 and KS-1612 for the backend contract.
 */
export function useArchiveGamesByPosition(
  fen: string,
  filters: UseArchiveGamesByPositionFilters = {},
): UseArchiveGamesByPositionResult {
  const [items, setItems] = useState<ArchiveGamesByPositionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalApprox, setTotalApprox] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = useMemo(
    () => serializeKey(fen, filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      fen,
      filters.bucket,
      filters.sort,
      filters.minElo,
      filters.since,
      filters.result,
      filters.color,
      filters.move,
      filters.player,
      filters.eco,
    ],
  );

  // First-page effect: fires on fen/filter change with debounce.
  useEffect(() => {
    if (!fen) {
      setItems([]);
      setNextCursor(null);
      setHasMore(false);
      setTotalApprox(0);
      setIsLoading(false);
      setError(null);
      return undefined;
    }

    setIsLoading(true);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = buildParams(fen, filters, null);

      fetch(`${API_URL}/api/archive/games/by-position?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
        headers: authHeaders(),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as ArchiveGamesByPositionResponse;
          if (controller.signal.aborted) return;
          setItems(json.items);
          setNextCursor(json.nextCursor);
          setHasMore(json.hasMore);
          setTotalApprox(json.totalApprox);
          setError(null);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if ((err as Error | undefined)?.name === 'AbortError') return;
          if (controller.signal.aborted) return;
          setError((err as Error | undefined)?.message ?? 'Request failed');
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, key, refetchToken]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (!fen || !hasMore || !nextCursor || isLoading || isLoadingMore) return;

    setIsLoadingMore(true);
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const params = buildParams(fen, filters, nextCursor);

    fetch(`${API_URL}/api/archive/games/by-position?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
      headers: authHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ArchiveGamesByPositionResponse;
        if (controller.signal.aborted) return;
        setItems((prev) => [...prev, ...json.items]);
        setNextCursor(json.nextCursor);
        setHasMore(json.hasMore);
        setTotalApprox(json.totalApprox);
        setIsLoadingMore(false);
      })
      .catch((err: unknown) => {
        if ((err as Error | undefined)?.name === 'AbortError') return;
        if (controller.signal.aborted) return;
        setError((err as Error | undefined)?.message ?? 'Request failed');
        setIsLoadingMore(false);
      });
  }, [fen, hasMore, nextCursor, isLoading, isLoadingMore, filters]);

  const refetch = useCallback(() => {
    setRefetchToken((t) => t + 1);
  }, []);

  return {
    items,
    hasMore,
    nextCursor,
    totalApprox,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch,
  };
}
