import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../ApiError';
import type { CreateGameResponse } from '@kingside/shared';
import type { TimeControlCategory } from './useTimeControl';

type PieceColor = 'white' | 'black' | 'random';

/**
 * KS-4153: контроль времени локальной партии с ботом.
 * minutes/increment — выбранный пресет (по умолчанию Rapid 10+0).
 * noClock — режим «Без часов», таймер в `useLocalBotGame` не
 * запускается, доска показывает прочерк вместо времени.
 */
export type LocalBotTC = {
  minutes: number;
  increment: number;
  noClock: boolean;
};

export function useBotGame() {
  const navigate = useNavigate();
  const [botLevel, setBotLevel] = useState(3);
  const [botColor, setBotColor] = useState<PieceColor>('random');
  const [botTC, setBotTC] = useState<TimeControlCategory>('blitz');
  // KS-4153: локальный TC для гостя (Stockfish WASM). Хранится отдельно
  // от `botTC` (категория для серверной партии), потому что локальный
  // движок принимает явные секунды + инкремент, а не категорию.
  const [localBotTC, setLocalBotTC] = useState<LocalBotTC>({
    minutes: 10,
    increment: 0,
    noClock: false,
  });
  const [startingBot, setStartingBot] = useState(false);
  const [showBotTCModal, setShowBotTCModal] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);

  const handlePlayBot = async () => {
    setStartingBot(true);
    setBotError(null);
    try {
      const game = await api.post<CreateGameResponse>('/games/bot', {
        color: botColor,
        botLevel,
        timeControl: botTC,
      });
      navigate(`/game/${game.id}`);
    } catch (err) {
      setStartingBot(false);
      if (err instanceof ApiError) {
        setBotError(err.message);
      } else {
        setBotError('Failed to start game');
      }
    }
  };

  return {
    botLevel,
    setBotLevel,
    botColor,
    setBotColor,
    botTC,
    setBotTC,
    localBotTC,
    setLocalBotTC,
    startingBot,
    showBotTCModal,
    setShowBotTCModal,
    handlePlayBot,
    botError,
    setBotError,
  };
}
