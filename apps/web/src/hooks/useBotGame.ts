import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { CreateGameResponse } from '@kingside/shared';
import type { TimeControlCategory } from './useTimeControl';

type PieceColor = 'white' | 'black' | 'random';

export function useBotGame() {
  const navigate = useNavigate();
  const [botLevel, setBotLevel] = useState(3);
  const [botColor, setBotColor] = useState<PieceColor>('random');
  const [botTC, setBotTC] = useState<TimeControlCategory>('blitz');
  const [startingBot, setStartingBot] = useState(false);
  const [showBotTCModal, setShowBotTCModal] = useState(false);

  const handlePlayBot = async () => {
    setStartingBot(true);
    try {
      const game = await api.post<CreateGameResponse>('/api/games/bot', {
        color: botColor,
        botLevel,
        timeControl: botTC,
      });
      navigate(`/game/${game.id}`);
    } catch {
      setStartingBot(false);
    }
  };

  return {
    botLevel,
    setBotLevel,
    botColor,
    setBotColor,
    botTC,
    setBotTC,
    startingBot,
    showBotTCModal,
    setShowBotTCModal,
    handlePlayBot,
  };
}
