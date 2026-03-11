import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { matchmakingSocket } from '../socket';
import { api } from '../api';
import { MatchmakingEvents, type CustomTimeControl, type CreateGameResponse, type RatingFilterMode, type DailyPuzzleResponse } from '@kingside/shared';

type PieceColor = 'white' | 'black' | 'random';
type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

type TimeControlPreset = {
  minutes: number;
  increment: number;
  category: TimeControlCategory;
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

type LobbyMode = 'online' | 'bot';

type PuzzleRushStats = {
  best3: number;
  best5: number;
  totalSessions: number;
};

type GameRecord = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw';
  opponent: { id: string; username: string; ratingBefore: number | null };
  result: string;
  timeControlType: string | null;
  timeControl: string;
  createdAt: string;
};

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
  const [lobbyMode, setLobbyMode] = useState<LobbyMode>('online');
  const [ratingFilterMode, setRatingFilterMode] = useState<RatingFilterMode>('none');
  const [ratingMin, setRatingMin] = useState(800);
  const [ratingMax, setRatingMax] = useState(2200);
  const [ratingMinus, setRatingMinus] = useState(200);
  const [ratingPlus, setRatingPlus] = useState(200);

  // Widget data
  const [dailyPuzzle, setDailyPuzzle] = useState<DailyPuzzleResponse | null>(null);
  const [rushStats, setRushStats] = useState<PuzzleRushStats | null>(null);
  const [recentGames, setRecentGames] = useState<GameRecord[]>([]);
  const [widgetsLoading, setWidgetsLoading] = useState(true);

  const loadSavedControls = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.get<CustomTimeControl[]>('/api/users/me/time-controls');
      setSavedControls(data);
    } catch {
      // API may not be available yet
    }
  }, [user]);

  useEffect(() => {
    loadSavedControls();
  }, [loadSavedControls]);

  useEffect(() => {
    if (!user) {
      setWidgetsLoading(false);
      return;
    }
    Promise.all([
      api.get<DailyPuzzleResponse>('/api/puzzles/daily').catch(() => null),
      api.get<PuzzleRushStats>(`/api/users/${user.id}/puzzle-rush-stats`).catch(() => null),
      api.get<{ data: GameRecord[] }>(`/api/users/${user.id}/games?take=3`).catch(() => null),
    ]).then(([daily, rush, games]) => {
      setDailyPuzzle(daily);
      setRushStats(rush);
      setRecentGames(games?.data ?? []);
    }).finally(() => setWidgetsLoading(false));
  }, [user]);

  const [botLevel, setBotLevel] = useState(3);
  const [botColor, setBotColor] = useState<PieceColor>('random');
  const [botTC, setBotTC] = useState<TimeControlCategory>('blitz');
  const [startingBot, setStartingBot] = useState(false);
  const [showBotTCModal, setShowBotTCModal] = useState(false);

  useEffect(() => {
    const onMatchFound = (data: { gameId: string; color: 'white' | 'black' }) => {
      setSearching(false);
      navigate(`/game/${data.gameId}`, { state: { color: data.color } });
    };

    matchmakingSocket.on(MatchmakingEvents.FOUND, onMatchFound);
    return () => {
      matchmakingSocket.off(MatchmakingEvents.FOUND, onMatchFound);
      if (searching) {
        matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      }
    };
  }, [navigate, searching]);

  const handleSelectPreset = (minutes: number, increment: number) => {
    setSelectedMinutes(minutes);
    setSelectedIncrement(increment);
  };

  const handleSearch = () => {
    if (searching) {
      matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      setSearching(false);
    } else {
      const payload: Record<string, unknown> = {
        timeInitial: selectedMinutes * 60,
        increment: selectedIncrement,
      };
      if (ratingFilterMode === 'absolute') {
        payload.ratingFilter = { minRating: ratingMin, maxRating: ratingMax };
      } else if (ratingFilterMode === 'relative' && user) {
        const ratingKey = `rating${activeTab !== 'custom' ? activeTab.charAt(0).toUpperCase() + activeTab.slice(1) : 'Blitz'}` as keyof typeof user;
        const myRating = Number(user[ratingKey]) || 1500;
        payload.ratingFilter = {
          minRating: myRating - ratingMinus,
          maxRating: myRating + ratingPlus,
        };
      }
      matchmakingSocket.emit(MatchmakingEvents.JOIN, payload);
      setSearching(true);
    }
  };

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

  const handleSaveCustom = async () => {
    if (!user) return;
    try {
      await api.post('/api/users/me/time-controls', {
        initialSec: customMinutes * 60,
        incrementSec: customIncrement,
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
      await api.delete(`/api/users/me/time-controls/${id}`);
      setSavedControls((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // API may not be available yet
    }
  };

  const handleSelectSaved = (ctrl: CustomTimeControl) => {
    setSelectedMinutes(Math.floor(ctrl.initialSec / 60));
    setSelectedIncrement(ctrl.incrementSec);
  };

  const isSelected = (minutes: number, increment: number) =>
    selectedMinutes === minutes && selectedIncrement === increment;

  const filteredPresets =
    activeTab === 'custom'
      ? []
      : PRESETS.filter((p) => p.category === activeTab);

  const onlinePanel = (
    <div className="lobby-panel lobby-panel--online">
      <h2 className="lobby-panel__title">{t('lobby.play')}</h2>

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
                {savedControls.map((ctrl) => {
                  const mins = Math.floor(ctrl.initialSec / 60);
                  const inc = ctrl.incrementSec;
                  return (
                  <div key={ctrl.id} className="saved-control-item">
                    <button
                      className={`tc-btn ${isSelected(mins, inc) ? 'active' : ''}`}
                      onClick={() => handleSelectSaved(ctrl)}
                      disabled={searching}
                    >
                      {inc > 0
                        ? `${mins} | ${inc}`
                        : `${mins} min`}
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
                  );
                })}
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

      <div className="rating-filter">
        <div className="rating-filter__header">
          <label className="rating-filter__toggle">
            <input
              type="checkbox"
              checked={ratingFilterMode !== 'none'}
              onChange={(e) => setRatingFilterMode(e.target.checked ? 'relative' : 'none')}
              disabled={searching}
            />
            {t('lobby.ratingFilter.title')}
          </label>
        </div>

        {ratingFilterMode !== 'none' && (
          <div className="rating-filter__body">
            <div className="rating-filter__modes">
              <button
                className={`rating-filter__mode-btn ${ratingFilterMode === 'relative' ? 'active' : ''}`}
                onClick={() => setRatingFilterMode('relative')}
                disabled={searching}
              >
                {t('lobby.ratingFilter.relative')}
              </button>
              <button
                className={`rating-filter__mode-btn ${ratingFilterMode === 'absolute' ? 'active' : ''}`}
                onClick={() => setRatingFilterMode('absolute')}
                disabled={searching}
              >
                {t('lobby.ratingFilter.absolute')}
              </button>
            </div>

            {ratingFilterMode === 'relative' && (
              <div className="rating-filter__fields">
                <label>
                  <span>−</span>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={ratingMinus}
                    onChange={(e) => setRatingMinus(Math.max(0, Math.min(1000, Number(e.target.value))))}
                    disabled={searching}
                  />
                </label>
                <label>
                  <span>+</span>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={ratingPlus}
                    onChange={(e) => setRatingPlus(Math.max(0, Math.min(1000, Number(e.target.value))))}
                    disabled={searching}
                  />
                </label>
              </div>
            )}

            {ratingFilterMode === 'absolute' && (
              <div className="rating-filter__fields">
                <label>
                  <span>{t('lobby.ratingFilter.from')}</span>
                  <input
                    type="number"
                    min={0}
                    max={4000}
                    value={ratingMin}
                    onChange={(e) => setRatingMin(Math.max(0, Math.min(4000, Number(e.target.value))))}
                    disabled={searching}
                  />
                </label>
                <label>
                  <span>{t('lobby.ratingFilter.to')}</span>
                  <input
                    type="number"
                    min={0}
                    max={4000}
                    value={ratingMax}
                    onChange={(e) => setRatingMax(Math.max(0, Math.min(4000, Number(e.target.value))))}
                    disabled={searching}
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      <button className="play-btn" onClick={handleSearch}>
        {searching ? t('lobby.cancelSearch') : t('lobby.play')}
      </button>
      {searching && <p className="searching">{t('lobby.searching')}</p>}
    </div>
  );

  const botPanel = (
    <div className="lobby-panel lobby-panel--bot">
      <h2 className="lobby-panel__title">{t('lobby.playBot')}</h2>

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
          {(['white', 'black', 'random'] as PieceColor[]).map((c) => {
            const icon = c === 'white' ? '♔' : c === 'black' ? '♚' : '⚄';
            return (
              <button
                key={c}
                className={`color-btn color-btn--icon color-btn--${c} ${botColor === c ? 'active' : ''}`}
                onClick={() => setBotColor(c)}
                title={t(`lobby.color_${c}`)}
                aria-label={t(`lobby.color_${c}`)}
              >
                {icon}
              </button>
            );
          })}
        </div>
      </div>

      <button className="play-btn" onClick={() => setShowBotTCModal(true)} disabled={startingBot}>
        {t('lobby.playBot')}
      </button>
    </div>
  );

  const dailyPuzzleWidget = (
    <div className="lobby-widget">
      <h3 className="lobby-widget__title">🧩 {t('lobby.dailyPuzzle')}</h3>
      {widgetsLoading ? (
        <p className="lobby-widget__loading">{t('common.loading')}</p>
      ) : dailyPuzzle ? (
        <div className="lobby-widget__content">
          <p className="lobby-widget__stat">
            {t('lobby.rating', { rating: dailyPuzzle.puzzle.rating })}
          </p>
          {dailyPuzzle.puzzle.themes.length > 0 && (
            <p className="lobby-widget__themes">
              {dailyPuzzle.puzzle.themes.slice(0, 3).join(', ')}
            </p>
          )}
        </div>
      ) : null}
      <div className="lobby-widget__actions">
        <Link to="/daily" className="lobby-widget__btn">
          {t('lobby.solve')} →
        </Link>
      </div>
    </div>
  );

  const puzzleRushWidget = (
    <div className="lobby-widget">
      <h3 className="lobby-widget__title">⚡ {t('lobby.puzzleRush')}</h3>
      {widgetsLoading ? (
        <p className="lobby-widget__loading">{t('common.loading')}</p>
      ) : rushStats && (rushStats.best3 > 0 || rushStats.best5 > 0) ? (
        <div className="lobby-widget__content">
          <p className="lobby-widget__stat">
            {t('lobby.myRecord')} 3 {t('lobby.min')}: {rushStats.best3}
          </p>
          <p className="lobby-widget__stat">
            {t('lobby.myRecord')} 5 {t('lobby.min')}: {rushStats.best5}
          </p>
        </div>
      ) : null}
      <div className="lobby-widget__actions">
        <Link to="/puzzle-rush" className="lobby-widget__btn">
          {t('lobby.play')} →
        </Link>
        <Link to="/puzzle-rush/leaderboard" className="lobby-widget__btn lobby-widget__btn--secondary">
          {t('lobby.leaderboard')} →
        </Link>
      </div>
    </div>
  );

  const recentGamesWidget = (
    <div className="lobby-widget">
      <h3 className="lobby-widget__title">📋 {t('lobby.recentGames')}</h3>
      {widgetsLoading ? (
        <p className="lobby-widget__loading">{t('common.loading')}</p>
      ) : recentGames.length > 0 ? (
        <div className="lobby-widget__content">
          {recentGames.map((game) => {
            const icon = game.playerResult === 'win' ? '✅' : game.playerResult === 'loss' ? '❌' : '➖';
            const date = new Date(game.createdAt).toLocaleDateString();
            return (
              <Link key={game.id} to={`/game/${game.id}/review`} className="lobby-widget__game-row">
                <span className="lobby-widget__game-icon">{icon}</span>
                <span className="lobby-widget__game-opponent">
                  vs {game.opponent.username}
                  {game.opponent.ratingBefore != null ? ` (${game.opponent.ratingBefore})` : ''}
                </span>
                <span className="lobby-widget__game-meta">
                  {game.timeControlType ?? game.timeControl}
                </span>
                <span className="lobby-widget__game-date">{date}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
      <div className="lobby-widget__actions">
        <Link to="/profile" className="lobby-widget__btn">
          {t('lobby.allGames')} →
        </Link>
      </div>
    </div>
  );

  return (
    <div className="lobby-page">
      <h1>{t('lobby.title')}</h1>
      {user && (
        <p className="user-info">
          {user.username} &middot; {t('lobby.rating', { rating: user[`rating${activeTab !== 'custom' ? activeTab.charAt(0).toUpperCase() + activeTab.slice(1) : 'Blitz'}` as keyof typeof user] })}
        </p>
      )}

      <div className="lobby-layout">
        {/* Left: Play Panel */}
        <div className="lobby-play-area">
          {/* Mobile tabs */}
          <div className="lobby-mode-tabs">
            <button
              className={`lobby-mode-tab ${lobbyMode === 'online' ? 'active' : ''}`}
              onClick={() => setLobbyMode('online')}
            >
              {t('lobby.play')}
            </button>
            <button
              className={`lobby-mode-tab ${lobbyMode === 'bot' ? 'active' : ''}`}
              onClick={() => setLobbyMode('bot')}
            >
              {t('lobby.playBot')}
            </button>
          </div>

          {/* Desktop: two columns, Mobile: active tab content */}
          <div className="lobby-columns">
            <div className={`lobby-column ${lobbyMode === 'online' ? 'lobby-column--active' : ''}`}>
              {onlinePanel}
            </div>
            <div className={`lobby-column ${lobbyMode === 'bot' ? 'lobby-column--active' : ''}`}>
              {botPanel}
            </div>
          </div>
        </div>

        {/* Right: Side Panel with widgets */}
        <div className="lobby-side-panel">
          {dailyPuzzleWidget}
          {puzzleRushWidget}
          {recentGamesWidget}
        </div>
      </div>

      {showBotTCModal && (
        <div className="bot-tc-modal-overlay" onClick={() => setShowBotTCModal(false)}>
          <div className="bot-tc-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="bot-tc-modal__title">{t('lobby.timeControl')}</h3>
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
            <button
              className="play-btn"
              onClick={() => { setShowBotTCModal(false); handlePlayBot(); }}
              disabled={startingBot}
            >
              {startingBot ? t('lobby.startingBot') : t('lobby.playBot')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
