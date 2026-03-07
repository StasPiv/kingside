import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TIME_CONTROLS } from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { matchmakingSocket } from '../socket';
import { api } from '../api';

type TimeControlKey = keyof typeof TIME_CONTROLS;
type PieceColor = 'white' | 'black' | 'random';

const TC_LABEL_KEYS: Record<TimeControlKey, string> = {
  bullet: 'lobby.bullet',
  blitz: 'lobby.blitz',
  rapid: 'lobby.rapid',
  classical: 'lobby.classical',
} as const;

export function LobbyPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searching, setSearching] = useState(false);
  const [selectedTC, setSelectedTC] = useState<TimeControlKey>('blitz');

  const [botLevel, setBotLevel] = useState(3);
  const [botColor, setBotColor] = useState<PieceColor>('random');
  const [botTC, setBotTC] = useState<TimeControlKey>('blitz');
  const [startingBot, setStartingBot] = useState(false);

  useEffect(() => {
    const onMatchFound = (data: { gameId: string; color: 'white' | 'black' }) => {
      setSearching(false);
      navigate(`/game/${data.gameId}`, { state: { color: data.color } });
    };

    matchmakingSocket.on('matchmaking:found', onMatchFound);
    return () => {
      matchmakingSocket.off('matchmaking:found', onMatchFound);
      if (searching) {
        matchmakingSocket.emit('matchmaking:leave');
      }
    };
  }, [navigate, searching]);

  const handleSearch = () => {
    if (searching) {
      matchmakingSocket.emit('matchmaking:leave');
      setSearching(false);
    } else {
      const tc = TIME_CONTROLS[selectedTC];
      matchmakingSocket.emit('matchmaking:join', {
        timeControl: selectedTC,
        timeInitial: tc.initialTime,
        increment: tc.increment,
      });
      setSearching(true);
    }
  };

  const handlePlayBot = async () => {
    setStartingBot(true);
    try {
      const game = await api.post<{ id: string }>('/api/games/bot', {
        color: botColor,
        botLevel,
        timeControl: botTC,
      });
      navigate(`/game/${game.id}`);
    } catch {
      setStartingBot(false);
    }
  };

  return (
    <div className="lobby-page">
      <h1>{t('lobby.title')}</h1>
      {user && (
        <p className="user-info">
          {user.username} &middot; {t('lobby.rating', { rating: user[`rating${selectedTC.charAt(0).toUpperCase() + selectedTC.slice(1)}` as keyof typeof user] })}
        </p>
      )}
      <div className="time-controls">
        {(Object.keys(TIME_CONTROLS) as TimeControlKey[]).map((key) => (
          <button
            key={key}
            className={`tc-btn ${selectedTC === key ? 'active' : ''}`}
            onClick={() => setSelectedTC(key)}
            disabled={searching}
          >
            {t(TC_LABEL_KEYS[key])}
          </button>
        ))}
      </div>
      <button className="play-btn" onClick={handleSearch}>
        {searching ? t('lobby.cancelSearch') : t('lobby.play')}
      </button>
      {searching && <p className="searching">{t('lobby.searching')}</p>}

      <div className="bot-section">
        <h2>{t('lobby.playBot')}</h2>

        <div className="bot-option">
          <label>{t('lobby.difficulty')}</label>
          <div className="bot-level-picker">
            <input
              type="range"
              min={1}
              max={20}
              value={botLevel}
              onChange={(e) => setBotLevel(Number(e.target.value))}
            />
            <span className="bot-level-value">{botLevel}</span>
          </div>
        </div>

        <div className="bot-option">
          <label>{t('lobby.color')}</label>
          <div className="color-picker">
            {(['white', 'black', 'random'] as PieceColor[]).map((c) => (
              <button
                key={c}
                className={`color-btn ${botColor === c ? 'active' : ''}`}
                onClick={() => setBotColor(c)}
              >
                {t(`lobby.color_${c}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="bot-option">
          <label>{t('lobby.timeControl')}</label>
          <div className="time-controls">
            {(Object.keys(TIME_CONTROLS) as TimeControlKey[]).map((key) => (
              <button
                key={key}
                className={`tc-btn ${botTC === key ? 'active' : ''}`}
                onClick={() => setBotTC(key)}
              >
                {t(TC_LABEL_KEYS[key])}
              </button>
            ))}
          </div>
        </div>

        <button className="play-btn" onClick={handlePlayBot} disabled={startingBot}>
          {startingBot ? t('lobby.startingBot') : t('lobby.playBot')}
        </button>
      </div>
    </div>
  );
}
