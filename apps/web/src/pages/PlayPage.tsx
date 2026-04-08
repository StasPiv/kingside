import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { useTimeControl, CATEGORIES, presetKey } from '../hooks/useTimeControl';
import { useMatchmaking } from '../hooks/useMatchmaking';
import { useBotGame } from '../hooks/useBotGame';
import { useChallenge } from '../hooks/useChallenge';
import { useLazySocket } from '../hooks/useLazySocket';
import { messagesSocket } from '../socket';
import { ChallengeModal } from '../components/ChallengeModal';
import type { TimeControlCategory } from '../hooks/useTimeControl';
import { TC_LABEL_KEYS } from '../hooks/useTimeControl';
import '../styles/play.css';

type FriendItem = {
  friendshipId: string;
  user: { id: string; username: string; ratingBlitz: number };
  online: boolean;
  since: string;
};

export function PlayPage() {
  useLazySocket(messagesSocket); // challenges
  const { t } = useTranslation();
  const { user } = useAuth();

  const tc = useTimeControl();
  const matchmaking = useMatchmaking();
  const bot = useBotGame();
  const { sendChallenge, state: challengeState, error: challengeError, cancel: cancelChallenge } = useChallenge();

  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [challengeTarget, setChallengeTarget] = useState<{ id: string; username: string } | null>(null);
  const [friendOpen, setFriendOpen] = useState(false);
  const [botOpen, setBotOpen] = useState(false);

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

  // Load online friends
  const fetchFriends = useCallback(async () => {
    if (!user) return;
    setFriendsLoading(true);
    try {
      const res = await api.get<{ data: FriendItem[] }>('/api/friends');
      setFriends(res.data.filter((f) => f.online));
    } catch {
      setFriends([]);
    } finally {
      setFriendsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchFriends();
  }, [fetchFriends]);

  const onlineFriends = friends;

  return (
    <div className="play-page">
      <h1 className="play-page__title">{t('play.title', 'Play')}</h1>

      <div className="play-page__grid">
        {/* Left column: Quick Play */}
        <div className="play-section play-section--quick">
          <h2 className="play-section__title">{t('play.quickPlay', 'Quick Play')}</h2>

          <div className="play-tc-tabs">
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
            <div className="play-tc-grid">
              {filteredPresets.map((p) => {
                const key = presetKey(p.minutes, p.increment);
                return (
                  <button
                    key={key}
                    className={`play-tc-btn ${isSelected(p.minutes, p.increment) ? 'active' : ''}`}
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
                  <div className="play-tc-grid">
                    {savedControls.map((ctrl) => {
                      const mins = Math.floor(ctrl.initialSec / 60);
                      const inc = ctrl.incrementSec;
                      return (
                        <div key={ctrl.id} className="saved-control-item">
                          <button
                            className={`play-tc-btn ${isSelected(mins, inc) ? 'active' : ''}`}
                            onClick={() => handleSelectSaved(ctrl)}
                            disabled={searching}
                          >
                            {inc > 0 ? `${mins} | ${inc}` : `${mins} min`}
                          </button>
                          <button className="delete-btn" onClick={() => handleDeleteSaved(ctrl.id)} disabled={searching} title="Delete">x</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {!showCustomForm ? (
                <button className="custom-tc-btn" onClick={() => setShowCustomForm(true)} disabled={searching}>
                  + {t('lobby.customControl.button')}
                </button>
              ) : (
                <div className="custom-tc-form">
                  <h3>{t('lobby.customControl.title')}</h3>
                  <div className="custom-tc-fields">
                    <label>
                      {t('lobby.customControl.minutes')}
                      <input type="number" min={1} max={180} value={customMinutes} onChange={(e) => setCustomMinutes(Math.max(1, Math.min(180, Number(e.target.value))))} />
                    </label>
                    <label>
                      {t('lobby.customControl.increment')}
                      <input type="number" min={0} max={180} value={customIncrement} onChange={(e) => setCustomIncrement(Math.max(0, Math.min(180, Number(e.target.value))))} />
                    </label>
                  </div>
                  <div className="custom-tc-actions">
                    <button onClick={handleUseCustom}>{t('lobby.customControl.use')}</button>
                    {user && <button onClick={handleSaveCustom}>{t('lobby.customControl.save')}</button>}
                    <button className="cancel-btn" onClick={() => setShowCustomForm(false)}>{t('lobby.customControl.cancel')}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="play-selected-tc">
            {selectedIncrement > 0 ? `${selectedMinutes} + ${selectedIncrement}` : `${selectedMinutes} min`}
          </div>

          {/* Rating filter */}
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
                  <button className={`rating-filter__mode-btn ${ratingFilterMode === 'relative' ? 'active' : ''}`} onClick={() => setRatingFilterMode('relative')} disabled={searching}>
                    {t('lobby.ratingFilter.relative')}
                  </button>
                  <button className={`rating-filter__mode-btn ${ratingFilterMode === 'absolute' ? 'active' : ''}`} onClick={() => setRatingFilterMode('absolute')} disabled={searching}>
                    {t('lobby.ratingFilter.absolute')}
                  </button>
                </div>
                {ratingFilterMode === 'relative' && (
                  <div className="rating-filter__fields">
                    <label><span>−</span><input type="number" min={0} max={1000} value={ratingMinus} onChange={(e) => setRatingMinus(Math.max(0, Math.min(1000, Number(e.target.value))))} disabled={searching} /></label>
                    <label><span>+</span><input type="number" min={0} max={1000} value={ratingPlus} onChange={(e) => setRatingPlus(Math.max(0, Math.min(1000, Number(e.target.value))))} disabled={searching} /></label>
                  </div>
                )}
                {ratingFilterMode === 'absolute' && (
                  <div className="rating-filter__fields">
                    <label><span>{t('lobby.ratingFilter.from')}</span><input type="number" min={0} max={4000} value={ratingMin} onChange={(e) => setRatingMin(Math.max(0, Math.min(4000, Number(e.target.value))))} disabled={searching} /></label>
                    <label><span>{t('lobby.ratingFilter.to')}</span><input type="number" min={0} max={4000} value={ratingMax} onChange={(e) => setRatingMax(Math.max(0, Math.min(4000, Number(e.target.value))))} disabled={searching} /></label>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            className={`play-btn play-btn--big${searching ? ' searching' : ''}`}
            onClick={() => handleSearch({ timeInitial: selectedMinutes * 60, increment: selectedIncrement, activeTab })}
          >
            {searching ? t('lobby.cancelSearch') : t('lobby.play')}
          </button>
          {searching && <p className="searching">{t('lobby.searching')}</p>}
        </div>

        {/* Right column */}
        <div className="play-section play-section--right">
          {/* Play a Friend */}
          <div className="play-card">
            <button className="play-card__header" onClick={() => setFriendOpen(!friendOpen)}>
              <h2 className="play-card__title">👥 {t('play.playFriend', 'Play a Friend')}</h2>
              <span className="play-card__toggle">{friendOpen ? '▲' : '▼'}</span>
            </button>
            <div className={`play-card__body${friendOpen ? ' play-card__body--open' : ''}`}>
              {friendsLoading ? (
                <p className="play-card__loading">{t('common.loading', 'Loading...')}</p>
              ) : onlineFriends.length > 0 ? (
                <ul className="play-friends-list">
                  {onlineFriends.map((f) => (
                    <li key={f.friendshipId} className="play-friend-item">
                      <span className="play-friend-status" />
                      <Link to={`/player/${f.user.username}`} className="play-friend-name">{f.user.username}</Link>
                      <span className="play-friend-rating">{f.user.ratingBlitz}</span>
                      <button className="play-friend-invite" onClick={() => setChallengeTarget({ id: f.user.id, username: f.user.username })}>
                        ♟ {t('play.invite', 'Invite')}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="play-card__empty">
                  <p>{t('play.noFriendsOnline', 'No friends online')}</p>
                  <Link to="/friends" className="play-card__link">{t('play.goToFriends', 'Find friends →')}</Link>
                </div>
              )}
            </div>
          </div>

          {/* Play vs Bot */}
          <div className="play-card">
            <button className="play-card__header" onClick={() => setBotOpen(!botOpen)}>
              <h2 className="play-card__title">🤖 {t('play.playBot', 'Play vs Bot')}</h2>
              <span className="play-card__toggle">{botOpen ? '▲' : '▼'}</span>
            </button>
            <div className={`play-card__body${botOpen ? ' play-card__body--open' : ''}`}>
              <div className="bot-option">
                <label>{t('lobby.difficulty')}</label>
                <div className="bot-level-picker">
                  <input type="range" min={1} max={20} value={botLevel} onChange={(e) => setBotLevel(Number(e.target.value))} />
                  <span className="bot-level-value">{botLevel}</span>
                </div>
              </div>
              <div className="bot-option">
                <label>{t('lobby.color')}</label>
                <div className="color-picker">
                  {(['white', 'black', 'random'] as const).map((c) => {
                    const icon = c === 'white' ? '♔' : c === 'black' ? '♚' : '⚄';
                    return (
                      <button key={c} className={`color-btn color-btn--icon color-btn--${c} ${botColor === c ? 'active' : ''}`} onClick={() => setBotColor(c)} title={t(`lobby.color_${c}`)} aria-label={t(`lobby.color_${c}`)}>
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
          </div>
        </div>
      </div>

      {/* Bot TC modal */}
      {showBotTCModal && (
        <div className="bot-tc-modal-overlay" onClick={() => setShowBotTCModal(false)}>
          <div className="bot-tc-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="bot-tc-modal__title">{t('lobby.timeControl')}</h3>
            <div className="time-controls">
              {CATEGORIES.map((key: TimeControlCategory) => (
                <button key={key} className={`tc-btn ${botTC === key ? 'active' : ''}`} onClick={() => setBotTC(key)}>
                  {t(TC_LABEL_KEYS[key])}
                </button>
              ))}
            </div>
            <button className="play-btn" onClick={() => { setShowBotTCModal(false); handlePlayBot(); }} disabled={startingBot}>
              {startingBot ? t('lobby.startingBot') : t('lobby.playBot')}
            </button>
          </div>
        </div>
      )}

      {/* Challenge modal */}
      {challengeTarget && (
        <ChallengeModal
          targetUsername={challengeTarget.username}
          waiting={challengeState === 'waiting'}
          error={challengeError}
          onSend={(timeInitial, increment) => sendChallenge({ targetUserId: challengeTarget.id, timeInitial, increment })}
          onClose={() => { cancelChallenge(); setChallengeTarget(null); }}
        />
      )}
    </div>
  );
}
