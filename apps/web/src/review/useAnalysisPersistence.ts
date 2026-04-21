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
  const pendingSaveRef = useRef<boolean>(false);
  const historyRef = useRef<ChessMove[]>(history);
  const gameIdRef = useRef<string | undefined>(gameId);

  useEffect(() => {
    historyRef.current = history;
    gameIdRef.current = gameId;
  });

  useEffect(() => {
    if (!gameId) return;
    if (history.length === 0) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    pendingSaveRef.current = true;

    timerRef.current = setTimeout(() => {
      pendingSaveRef.current = false;
      const pgn = serializeToAnnotatedPgn(history);
      api.put(`/games/${gameId}/analysis`, { analysisPgn: pgn }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [gameId, history]);

  useEffect(() => {
    return () => {
      if (!pendingSaveRef.current) return;
      const currentGameId = gameIdRef.current;
      const currentHistory = historyRef.current;
      if (!currentGameId || currentHistory.length === 0) return;
      const token = localStorage.getItem('token');
      if (!token) return;
      const pgn = serializeToAnnotatedPgn(currentHistory);
      api.put(`/games/${currentGameId}/analysis`, { analysisPgn: pgn }).catch(() => {});
    };
  }, []);
}
