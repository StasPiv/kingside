import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveBucket, ArchiveTreeResponse } from '@kingside/shared';
import { ARCHIVE_URL } from '../config/archiveUrl';

const DEBOUNCE_MS = 300;

export interface UseArchiveTreeFilters {
  bucket?: ArchiveBucket;
  minElo?: number;
  since?: string;
}

export interface UseArchiveTreeResult {
  data: ArchiveTreeResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

function serializeFilters(fen: string, f: UseArchiveTreeFilters): string {
  return [fen, f.bucket ?? '', f.minElo ?? '', f.since ?? ''].join('|');
}

/**
 * Queries the archive variation tree for a given FEN with debounce, abort,
 * and in-memory caching.
 *
 * - 300ms debounce before issuing the request.
 * - Any in-flight request is aborted when `fen`/filters change.
 * - Successful responses are cached by key `fen|bucket|minElo|since`.
 * - `refetch()` invalidates the current key and re-queries.
 */
export function useArchiveTree(
  fen: string,
  filters: UseArchiveTreeFilters = {},
): UseArchiveTreeResult {
  const [data, setData] = useState<ArchiveTreeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  const cacheRef = useRef<Map<string, ArchiveTreeResponse>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cacheKey = useMemo(
    () => serializeFilters(fen, filters),
    // bucket/minElo/since values matter, not the object identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fen, filters.bucket, filters.minElo, filters.since],
  );

  useEffect(() => {
    if (!fen) return undefined;

    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      abortRef.current?.abort();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setData(cached);
      setError(null);
      setIsLoading(false);
      return undefined;
    }

    setIsLoading(true);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({ fen });
      if (filters.bucket) params.set('bucket', filters.bucket);
      if (typeof filters.minElo === 'number') params.set('minElo', String(filters.minElo));
      if (filters.since) params.set('since', filters.since);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      try {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch {
        /* ignore */
      }

      fetch(`${ARCHIVE_URL}/tree?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as ArchiveTreeResponse;
          if (controller.signal.aborted) return;
          cacheRef.current.set(cacheKey, json);
          setData(json);
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
  }, [fen, cacheKey, filters.bucket, filters.minElo, filters.since, refetchToken]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const refetch = useCallback(() => {
    cacheRef.current.delete(cacheKey);
    setRefetchToken((t) => t + 1);
  }, [cacheKey]);

  return { data, isLoading, error, refetch };
}
