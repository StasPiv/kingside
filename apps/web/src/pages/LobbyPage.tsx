import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { useTimeControl, CATEGORIES, presetKey, TC_LABEL_KEYS } from '../hooks/useTimeControl';
import { useMatchmaking } from '../hooks/useMatchmaking';
import { useBotGame } from '../hooks/useBotGame';
import type { TimeControlCategory } from '../hooks/useTimeControl';
import { HelpButton } from '../components/HelpButton';

type WorkshopGame = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw';
  opponent: { username: string };
  result: string;
  timeControl: string;
  createdAt: string;
};

type PuzzleRushStats = {
  best3: number;
  best5: number;
  totalSessions: number;
};

type ModalId = 'human' | 'bot' | 'puzzles' | 'rush' | 'workshop' | 'broadcasts' | 'players' | 'liveGames' | null;

export function LobbyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const tc = useTimeControl();
  const matchmaking = useMatchmaking();
  const bot = useBotGame();

  const [rushStats, setRushStats] = useState<PuzzleRushStats | null>(null);
  const [widgetsLoading, setWidgetsLoading] = useState(true);

  const [workshopGames, setWorkshopGames] = useState<WorkshopGame[]>([]);
  const [workshopGamesLoading, setWorkshopGamesLoading] = useState(false);
  const pgnInputRef = useRef<HTMLInputElement>(null);

  const [activeModal, setActiveModal] = useState<ModalId>(null);

  useEffect(() => {
    if (!user) {
      setWidgetsLoading(false);
      return;
    }
    api.get<PuzzleRushStats>(`/api/users/${user.id}/puzzle-rush-stats`)
      .catch(() => null)
      .then((rush) => {
        setRushStats(rush);
      }).finally(() => setWidgetsLoading(false));
  }, [user]);

  const loadWorkshopGames = useCallback(async () => {
    if (!user) return;
    setWorkshopGamesLoading(true);
    try {
      const data = await api.get<{ data: WorkshopGame[] }>(`/api/users/${user.id}/games?take=5`);
      setWorkshopGames(data.data);
    } catch {
      setWorkshopGames([]);
    } finally {
      setWorkshopGamesLoading(false);
    }
  }, [user]);

  const handlePgnFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const pgn = ev.target?.result as string;
      if (pgn) {
        navigate('/analysis', { state: { pgn } });
        closeModal();
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const closeModal = () => setActiveModal(null);

  const openModal = (id: NonNullable<ModalId>) => {
    setActiveModal(id);
    if (id === 'workshop') {
      loadWorkshopGames();
    }
  };

  const {
    selectedMinutes, selectedIncrement, showCustomForm, setShowCustomForm,
    customMinutes, setCustomMinutes, customIncrement, setCustomIncrement,
    savedControls, activeTab, setActiveTab,
    handleSelectPreset, handleSaveCustom, handleUseCustom, handleDeleteSaved, handleSelectSaved,
    isSelected, filteredPresets,
  } = tc;

  const {
    searching, ratingFilterMode, setRatingFilterMode,
    ratingMin, setRatingMin, ratingMax, setRatingMax,
    ratingMinus, setRatingMinus, ratingPlus, setRatingPlus,
    handleSearch,
  } = matchmaking;

  const {
    botLevel, setBotLevel, botColor, setBotColor,
    botTC, setBotTC, startingBot, showBotTCModal, setShowBotTCModal,
    handlePlayBot, botError, setBotError,
  } = bot;

  const onlineModalContent = (
    <div className="lobby-panel lobby-panel--online">
      <h2 className="lobby-panel__title">{t('lobby.teasers.human.title')}</h2>

      <div className="lobby-mode-tabs lobby-mode-tabs--modal">
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
                        {inc > 0 ? `${mins} | ${inc}` : `${mins} min`}
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

      <button
        className="play-btn"
        onClick={() => handleSearch({
          timeInitial: selectedMinutes * 60,
          increment: selectedIncrement,
          activeTab,
        })}
      >
        {searching ? t('lobby.cancelSearch') : t('lobby.play')}
      </button>
      {searching && <p className="searching">{t('lobby.searching')}</p>}
    </div>
  );

  const botModalContent = (
    <div className="lobby-panel lobby-panel--bot">
      <h2 className="lobby-panel__title">{t('lobby.teasers.bot.title')}</h2>

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
          {(['white', 'black', 'random'] as const).map((c) => {
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

      {botError && (
        <div className="bot-error-message">
          <p>{botError}</p>
          <button className="bot-error-dismiss" onClick={() => setBotError(null)}>✕</button>
        </div>
      )}
    </div>
  );

  const rushModalContent = (
    <div className="lobby-panel">
      <h2 className="lobby-panel__title">⚡ {t('lobby.teasers.rush.title')}</h2>
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
      <p className="lobby-modal__desc">{t('lobby.teasers.rush.modalDesc')}</p>
      <div className="lobby-widget__actions">
        <Link to="/puzzle-rush" className="lobby-widget__btn" onClick={closeModal}>
          {t('lobby.play')} →
        </Link>
        <Link to="/puzzle-rush/leaderboard" className="lobby-widget__btn lobby-widget__btn--secondary" onClick={closeModal}>
          {t('lobby.leaderboard')} →
        </Link>
      </div>
    </div>
  );

  const workshopModalContent = (
    <div className="lobby-panel">
      <h2 className="lobby-panel__title">&#9812; {t('lobby.teasers.workshop.title')}</h2>

      <div className="workshop-section">
        <button
          className="play-btn"
          onClick={() => { navigate('/analysis'); closeModal(); }}
        >
          {t('lobby.workshop.newGame')}
        </button>
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.uploadPgn')}</p>
        <input
          ref={pgnInputRef}
          type="file"
          accept=".pgn"
          style={{ display: 'none' }}
          onChange={handlePgnFileChange}
        />
        <button
          className="lobby-widget__btn lobby-widget__btn--secondary"
          onClick={() => pgnInputRef.current?.click()}
        >
          {t('lobby.workshop.uploadPgnBtn')}
        </button>
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.recentGames')}</p>
        {workshopGamesLoading ? (
          <p className="lobby-widget__loading">{t('common.loading')}</p>
        ) : workshopGames.length > 0 ? (
          <ul className="workshop-games-list">
            {workshopGames.map((g) => (
              <li key={g.id} className="workshop-game-item">
                <Link
                  to={`/game/${g.id}/review`}
                  className="workshop-game-link"
                  onClick={closeModal}
                >
                  <span className={`workshop-game-result workshop-game-result--${g.playerResult}`}>
                    {g.playerResult === 'win' ? '▲' : g.playerResult === 'loss' ? '▼' : '='}
                  </span>
                  <span className="workshop-game-opponent">vs {g.opponent.username}</span>
                  <span className="workshop-game-tc">{g.timeControl}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lobby-widget__loading">{t('lobby.workshop.noGames')}</p>
        )}
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.tournaments')}</p>
        <p className="workshop-section__stub">{t('lobby.workshop.tournamentsComingSoon')}</p>
      </div>

      <div className="lobby-widget__actions">
        <Link to="/workshop" className="lobby-widget__btn" onClick={closeModal}>
          {t('lobby.workshop.openWorkshop')} →
        </Link>
      </div>
    </div>
  );

  const teasers = [
    {
      id: 'human' as const,
      icon: '♟',
      titleKey: 'lobby.teasers.human.title',
      descKey: 'lobby.teasers.human.description',
      ctaKey: 'lobby.teasers.human.cta',
    },
    {
      id: 'bot' as const,
      icon: '🤖',
      titleKey: 'lobby.teasers.bot.title',
      descKey: 'lobby.teasers.bot.description',
      ctaKey: 'lobby.teasers.bot.cta',
    },
    {
      id: 'puzzles' as const,
      icon: '🧩',
      titleKey: 'lobby.teasers.puzzles.title',
      descKey: 'lobby.teasers.puzzles.description',
      ctaKey: 'lobby.teasers.puzzles.cta',
      to: '/puzzles',
    },
    {
      id: 'rush' as const,
      icon: '⚡',
      titleKey: 'lobby.teasers.rush.title',
      descKey: 'lobby.teasers.rush.description',
      ctaKey: 'lobby.teasers.rush.cta',
    },
    {
      id: 'workshop' as const,
      icon: '♟',
      titleKey: 'lobby.teasers.workshop.title',
      descKey: 'lobby.teasers.workshop.description',
      ctaKey: 'lobby.teasers.workshop.cta',
      to: '/workshop',
    },
    {
      id: 'broadcasts' as const,
      icon: '📡',
      titleKey: 'lobby.teasers.broadcasts.title',
      descKey: 'lobby.teasers.broadcasts.description',
      ctaKey: 'lobby.teasers.broadcasts.cta',
      to: '/broadcasts',
    },
    {
      id: 'players' as const,
      icon: '👥',
      titleKey: 'lobby.teasers.players.title',
      descKey: 'lobby.teasers.players.description',
      ctaKey: 'lobby.teasers.players.cta',
      to: '/players',
    },
    {
      id: 'liveGames' as const,
      icon: '👁',
      titleKey: 'lobby.teasers.liveGames.title',
      descKey: 'lobby.teasers.liveGames.description',
      ctaKey: 'lobby.teasers.liveGames.cta',
      to: '/games/live',
    },
  ] as Array<{ id: NonNullable<ModalId>; icon: string; titleKey: string; descKey: string; ctaKey: string; to?: string }>;

  const modalContentMap: Record<NonNullable<ModalId>, React.ReactNode> = {
    human: onlineModalContent,
    bot: botModalContent,
    rush: rushModalContent,
    workshop: workshopModalContent,
    puzzles: null,
    broadcasts: null,
    players: null,
    liveGames: null,
  };

  return (
    <div className="lobby-page">
      <h1>{t('lobby.title')}<HelpButton section="play" /></h1>
      {user ? (
        <p className="user-info">
          {user.username} &middot; {t('lobby.rating', { rating: user[`rating${activeTab !== 'custom' ? activeTab.charAt(0).toUpperCase() + activeTab.slice(1) : 'Blitz'}` as keyof typeof user] })}
        </p>
      ) : (
        <div className="guest-banner">
          <Link to="/login">{t('auth.loginToPlay', 'Sign in to play games')}</Link>
        </div>
      )}

      <div className="lobby-teasers">
        {teasers.map((teaser) => (
          <div key={teaser.id} className="lobby-teaser">
            <div className="lobby-teaser__image">{teaser.icon}</div>
            <h2 className="lobby-teaser__title">{t(teaser.titleKey)}</h2>
            <p className="lobby-teaser__desc">{t(teaser.descKey)}</p>
            <button
              className="lobby-teaser__btn"
              onClick={() => teaser.to ? navigate(teaser.to) : openModal(teaser.id)}
            >
              {t(teaser.ctaKey)}
            </button>
          </div>
        ))}
      </div>

      {activeModal && (
        <div className="lobby-modal-overlay" onClick={closeModal}>
          <div className="lobby-modal" onClick={(e) => e.stopPropagation()}>
            <button className="lobby-modal__close" onClick={closeModal} aria-label="Close">
              ×
            </button>
            {modalContentMap[activeModal]}
          </div>
        </div>
      )}

      {showBotTCModal && (
        <div className="bot-tc-modal-overlay" onClick={() => setShowBotTCModal(false)}>
          <div className="bot-tc-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="bot-tc-modal__title">{t('lobby.timeControl')}</h3>
            <div className="time-controls">
              {CATEGORIES.map((key: TimeControlCategory) => (
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
