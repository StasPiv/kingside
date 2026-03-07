import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TIME_CONTROLS } from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { socket } from '../socket';

type TimeControlKey = keyof typeof TIME_CONTROLS;

const TIME_CONTROL_LABELS: Record<TimeControlKey, string> = {
  bullet: 'Пуля (1 мин)',
  blitz: 'Блиц (5 мин)',
  rapid: 'Рапид (10 мин)',
  classical: 'Классика (30 мин)',
};

export function LobbyPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const [selectedTC, setSelectedTC] = useState<TimeControlKey>('blitz');

  useEffect(() => {
    const onMatchFound = (data: { gameId: string }) => {
      setSearching(false);
      navigate(`/game/${data.gameId}`);
    };

    socket.on('matchmaking:found', onMatchFound);
    return () => {
      socket.off('matchmaking:found', onMatchFound);
      if (searching) {
        socket.emit('matchmaking:leave');
      }
    };
  }, [navigate, searching]);

  const handleSearch = () => {
    if (searching) {
      socket.emit('matchmaking:leave');
      setSearching(false);
    } else {
      const tc = TIME_CONTROLS[selectedTC];
      socket.emit('matchmaking:join', {
        timeControl: selectedTC,
        timeInitial: tc.initialTime,
        increment: tc.increment,
      });
      setSearching(true);
    }
  };

  return (
    <div className="lobby-page">
      <h1>Лобби</h1>
      {user && (
        <p className="user-info">
          {user.username} &middot; Рейтинг: {user.rating}
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
            {TIME_CONTROL_LABELS[key]}
          </button>
        ))}
      </div>
      <button className="play-btn" onClick={handleSearch}>
        {searching ? 'Отменить поиск...' : 'Играть'}
      </button>
      {searching && <p className="searching">Поиск соперника...</p>}
    </div>
  );
}
