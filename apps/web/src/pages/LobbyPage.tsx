import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { matchmakingSocket } from '../socket';
import { api } from '../api';

type PieceColor = 'white' | 'black' | 'random';
type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

type TimeControlPreset = {
  minutes: number;
  increment: number;
  category: TimeControlCategory;
};

type CustomTimeControl = {
  id: string;
  minutes: number;
  increment: number;
};

const TC_LABEL_KEYS: Record<TimeControlCategory, string> = {
  bullet: 'lobby.bullet',
  blitz: 'lobby.blitz',
  rapid: 'lobby.rapid',
  classical: 'lobby.classical',
} as const;

const PRESETS: TimeControlPreset[] = [
  { minutes: 1, increment: 0, category: 'bullet' },
  { minutes: 1, increment: 1, category: 'bullet' },
  { minutes: 2, increment: 1, category: 'bullet' },
  { minutes: 3, increment: 0, category: 'blitz' },
  { minutes: 3, increment: 2, category: 'blitz' },
  { minutes: 5, increment: 0, category: 'blitz' },
  { minutes: 5, increment: 3, category: 'blitz' },
  { minutes: 10, increment: 0, category: 'rapid' },
  { minutes: 10, increment: 5, category: 'rapid' },
  { minutes: 15, increment: 10, category: 'rapid' },
  { minutes: 30, increment: 0, category: 'classical' },
  { minutes: 30, increment: 20, category: 'classical' },
  { minutes: 60, increment: 0, category: 'classical' },
];

const CATEGORIES: TimeControlCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];

function presetKey(minutes: number, increment: number): string {
  return `${minutes}+${increment}`;
}

export function LobbyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState(5);
  const [selectedIncrement, setSelectedIncrement] = useState(0);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(5);
  const [customIncrement, setCustomIncrement] = useState(0);
  const [savedControls, setSavedControls] = useState<CustomTimeControl[]>([]);
  const [activeTab, setActiveTab] = useState<TimeControlCategory | 'custom'>('blitz');

  const loadSavedControls = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.get<CustomTimeControl[]>('/time-controls/custom');
      setSavedControls(data);
    } catch {
      // API may not be available yet
    }
  }, [user]);

  useEffect(() => {
    loadSavedControls();
  }, [loadSavedControls]);

  const [botLevel, setBotLevel] = useState(3);
  const [botColor, setBotColor] = useState<PieceColor>('random');
  const [botTC, setBotTC] = useState<TimeControlCategory>('blitz');
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

  const handleSelectPreset = (minutes: number, increment: number) => {
    setSelectedMinutes(minutes);
    setSelectedIncrement(increment);
  };

  const handleSearch = () => {
    if (searching) {
      matchmakingSocket.emit('matchmaking:leave');
      setSearching(false);
    } else {
      matchmakingSocket.emit('matchmaking:join', {
        timeInitial: selectedMinutes * 60,
        increment: selectedIncrement,
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

  const handleSaveCustom = async () => {
    if (!user) return;
    try {
      await api.post('/time-controls/custom', {
        minutes: customMinutes,
        increment: customIncrement,
      });
      await loadSavedControls();
      setShowCustomForm(false);
    } catch {
      // API may not be available yet
    }
  };

  const handleUseCustom = () => {
    setSelectedMinutes(customMinutes);
    setSelectedIncrement(customIncrement);
    setShowCustomForm(false);
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      await api.delete(`/time-controls/custom/${id}`);
      setSavedControls((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // API may not be available yet
    }
  };

  const handleSelectSaved = (ctrl: CustomTimeControl) => {
    setSelectedMinutes(ctrl.minutes);
    setSelectedIncrement(ctrl.increment);
  };

  const isSelected = (minutes: number, increment: number) =>
    selectedMinutes === minutes && selectedIncrement === increment;

  const filteredPresets =
    activeTab === 'custom'
      ? []
      : PRESETS.filter((p) => p.category === activeTab);

  return (
    <div className="lobby-page">
      <h1>{t('lobby.title')}</h1>
      {user && (
        <p className="user-info">
          {user.username} &middot; {t('lobby.rating', { rating: user[`rating${activeTab !== 'custom' ? activeTab.charAt(0).toUpperCase() + activeTab.slice(1) : 'Blitz'}` as keyof typeof user] })}
        </p>
      )}

      <div className="tc-tabs">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`tc-tab ${activeTab === cat ? 'active' : ''}`}
            onClick={() => setActiveTab(cat)}
            disabled={searching}
          >
            {t(`lobby.categories.${cat}`)}
          </button>
        ))}
        <button
          className={`tc-tab ${activeTab === 'custom' ? 'active' : ''}`}
          onClick={() => setActiveTab('custom')}
          disabled={searching}
        >
          {t('lobby.categories.custom')}
        </button>
      </div>

      {activeTab !== 'custom' && (
        <div className="time-controls">
          {filteredPresets.map((p) => {
            const key = presetKey(p.minutes, p.increment);
            return (
              <button
                key={key}
                className={`tc-btn ${isSelected(p.minutes, p.increment) ? 'active' : ''}`}
                onClick={() => handleSelectPreset(p.minutes, p.increment)}
                disabled={searching}
              >
                {t(`lobby.presets.${key}`)}
              </button>
            );
          })}
        </div>
      )}

      {activeTab === 'custom' && (
        <div className="custom-tc-section">
          {savedControls.length > 0 && (
            <div className="saved-controls">
              <h3>{t('lobby.customControl.savedTitle')}</h3>
              <div className="time-controls">
                {savedControls.map((ctrl) => (
                  <div key={ctrl.id} className="saved-control-item">
                    <button
                      className={`tc-btn ${isSelected(ctrl.minutes, ctrl.increment) ? 'active' : ''}`}
                      onClick={() => handleSelectSaved(ctrl)}
                      disabled={searching}
                    >
                      {ctrl.increment > 0
                        ? `${ctrl.minutes} | ${ctrl.increment}`
                        : `${ctrl.minutes} min`}
                    </button>
                    <button
                      className="delete-btn"
                      onClick={() => handleDeleteSaved(ctrl.id)}
                      disabled={searching}
                      title="Delete"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!showCustomForm ? (
            <button
              className="custom-tc-btn"
              onClick={() => setShowCustomForm(true)}
              disabled={searching}
            >
              + {t('lobby.customControl.button')}
            </button>
          ) : (
            <div className="custom-tc-form">
              <h3>{t('lobby.customControl.title')}</h3>
              <div className="custom-tc-fields">
                <label>
                  {t('lobby.customControl.minutes')}
                  <input
                    type="number"
                    min={1}
                    max={180}
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Math.max(1, Math.min(180, Number(e.target.value))))}
                  />
                </label>
                <label>
                  {t('lobby.customControl.increment')}
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={customIncrement}
                    onChange={(e) => setCustomIncrement(Math.max(0, Math.min(180, Number(e.target.value))))}
                  />
                </label>
              </div>
              <div className="custom-tc-actions">
                <button onClick={handleUseCustom}>
                  {t('lobby.customControl.use')}
                </button>
                {user && (
                  <button onClick={handleSaveCustom}>
                    {t('lobby.customControl.save')}
                  </button>
                )}
                <button className="cancel-btn" onClick={() => setShowCustomForm(false)}>
                  {t('lobby.customControl.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="selected-tc-info">
        {selectedIncrement > 0
          ? `${selectedMinutes} + ${selectedIncrement}`
          : `${selectedMinutes} min`}
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
            {CATEGORIES.map((key) => (
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
