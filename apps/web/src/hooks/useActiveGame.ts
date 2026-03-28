import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface ActiveGame {
  gameId: string;
  opponent: string;
  timeControlType: string;
}

export function useActiveGame(isLoggedIn: boolean) {
  const [activeGame, setActiveGame] = useState<ActiveGame | null>(null);

  const fetchActiveGame = useCallback(async () => {
    if (!isLoggedIn) {
      setActiveGame(null);
      return;
    }
    try {
      const data = await api.get<ActiveGame | null>('/api/games/active');
      setActiveGame(data);
    } catch {
      setActiveGame(null);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    fetchActiveGame();
  }, [fetchActiveGame]);

  return { activeGame, refetchActiveGame: fetchActiveGame };
}
