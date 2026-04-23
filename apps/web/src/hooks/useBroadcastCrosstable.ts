import { useEffect, useRef, useState, useCallback } from 'react';
import type { CrosstableResponse } from '@kingside/shared';
import { broadcastApi } from '../api/broadcastApi';

/**
 * KS-1736 / ADR-023 §2.10 (A12).
 *
 * Хук загружает crosstable broadcast'а из `GET /:id/crosstable`.
 * Префикс `/broadcasts` НЕ используется — broadcast-service на субдомене
 * (KS-1702), путь относительный к BROADCAST_URL.
 *
 * Возвращает discriminated union `CrosstableResponse` (round-robin / swiss /
 * team-* / unknown) — фронт-диспетчер `<BroadcastCrosstable>` выбирает
 * рендер по `data.tournamentType`.
 */
export type UseBroadcastCrosstableResult = {
  data: CrosstableResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useBroadcastCrosstable(broadcastId: string | undefined): UseBroadcastCrosstableResult {
  const [data, setData] = useState<CrosstableResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(broadcastId));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const cancelledRef = useRef(false);

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!broadcastId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    cancelledRef.current = false;
    setLoading(true);
    setError(null);

    broadcastApi
      .get<CrosstableResponse>(`/${broadcastId}/crosstable`)
      .then((res) => {
        if (cancelledRef.current) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelledRef.current) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'Failed to load crosstable');
        setLoading(false);
      });

    return () => {
      cancelledRef.current = true;
    };
  }, [broadcastId, nonce]);

  return { data, loading, error, refetch };
}
