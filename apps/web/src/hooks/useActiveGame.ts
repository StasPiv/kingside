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
    // Poll every 10 seconds to catch game start/end
    const interval = setInterval(fetchActiveGame, 10_000);
    return () => clearInterval(interval);
  }, [fetchActiveGame]);

  // Listen for game:end event dispatched by GamePage
  useEffect(() => {
    const onGameEnd = () => {
      setActiveGame(null);
      // Re-fetch after a short delay (server may still be processing)
      setTimeout(fetchActiveGame, 1000);
    };
    window.addEventListener('game:ended', onGameEnd);
    return () => window.removeEventListener('game:ended', onGameEnd);
  }, [fetchActiveGame]);

  return { activeGame, refetchActiveGame: fetchActiveGame };
}
