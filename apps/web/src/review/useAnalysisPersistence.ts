import { useEffect, useRef } from 'react';
import { api } from '../api';
import type { ChessMove } from './types';
import { serializeToAnnotatedPgn } from './utils/PgnSerializer';

const DEBOUNCE_MS = 2000;

export function useAnalysisPersistence(
  gameId: string | undefined,
  history: ChessMove[],
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!gameId) return;
    if (history.length === 0) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      const pgn = serializeToAnnotatedPgn(history);
      api.put(`/api/games/${gameId}/analysis`, { analysisPgn: pgn }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [gameId, history]);
}
