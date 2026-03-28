import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { Locale } from '@kingside/shared';
import { useSounds } from '../hooks/useSounds';
import { useBoardSettings, BOARD_THEMES, PIECE_SETS } from '../hooks/useBoardSettings';
import { HelpButton } from '../components/HelpButton';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { muted, toggleMute } = useSounds();
  const { boardTheme, pieceSet, selectTheme, selectPieceSet, inputMode, setInputMode } = useBoardSettings();

  const [blocked, setBlocked] = useState<{ id: string; username: string }[]>([]);

  useEffect(() => {
    api.get<{ data: { id: string; username: string }[] }>('/api/users/blocked')
      .then(({ data }) => setBlocked(data))
      .catch(() => {});
  }, []);

  const handleUnblock = useCallback(async (userId: string) => {
    try {
      await api.delete(`/api/users/unblock/${userId}`);
      setBlocked((prev) => prev.filter((b) => b.id !== userId));
    } catch { /* ignore */ }
  }, []);

  const [animationDuration, setAnimationDuration] = useState<number>(() => {
    const saved = localStorage.getItem('pieceAnimationDuration');
    return saved !== null ? parseInt(saved, 10) : 200;
  });

  const handleAnimationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(e.target.value, 10);
    setAnimationDuration(value);
    localStorage.setItem('pieceAnimationDuration', String(value));
  };

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locale = e.target.value as Locale;
    i18n.changeLanguage(locale);
    localStorage.setItem('locale', locale);
    await api.patch('/api/users/me/settings', { locale });
  };

  return (
    <div className="settings-page">
      <h1>{t('settings.title')}<HelpButton section="customize" /></h1>

      <section className="settings-section">
        <h2>{t('settings.profile')}</h2>
        <div className="settings-field">
          <label>{t('settings.username')}</label>
          <input type="text" value={user?.username ?? ''} disabled />
        </div>
        <div className="settings-field">
          <label>{t('settings.email')}</label>
          <input type="email" value={user?.email ?? ''} disabled />
        </div>
        {user?.ratingPuzzle != null && (
          <div className="settings-field">
            <span className="settings-label">{t('settings.puzzleRating')}</span>
            <span className="settings-value">{user.ratingPuzzle}</span>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Доска</h2>

        <div className="settings-field" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <label>Тема доски</label>
          <div className="board-theme-options">
            {BOARD_THEMES.map((theme) => (
              <label
                key={theme.id}
                className={`board-theme-option${boardTheme === theme.id ? ' active' : ''}`}
                onClick={() => selectTheme(theme.id)}
              >
                <span
                  className="board-theme-preview"
                  style={{
                    background: `linear-gradient(135deg, ${theme.light} 50%, ${theme.dark} 50%)`,
                  }}
                />
                <span className="board-theme-label">{theme.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="settings-field" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 16 }}>
          <label>Режим ввода ходов</label>
          <select
            value={inputMode}
            onChange={(e) => setInputMode(e.target.value as 'drag' | 'click')}
          >
            <option value="drag">Перетаскивание</option>
            <option value="click">Два клика</option>
          </select>
        </div>

        <div className="settings-field" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 16 }}>
          <label>Набор фигур</label>
          <div className="piece-set-options">
            {PIECE_SETS.map((set) => (
              <label
                key={set.id}
                className={`piece-set-option${pieceSet === set.id ? ' active' : ''}`}
                onClick={() => selectPieceSet(set.id)}
              >
                <span className="piece-set-preview">
                  {set.id === 'standard' ? (
                    <span style={{ fontSize: 32, lineHeight: 1 }}>&#9822;</span>
                  ) : (
                    <img
                      src={`/pieces/${set.id}/wN.svg`}
                      alt={set.label}
                    />
                  )}
                </span>
                <span className="piece-set-label">{set.label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>{t('settings.language')}</h2>
        <div className="settings-field">
          <select
            id="language-select"
            value={i18n.language}
            onChange={handleLanguageChange}
          >
            <option value="en">{t('settings.english')}</option>
            <option value="ru">{t('settings.russian')}</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2>{t('settings.pieceAnimation')}</h2>
        <div className="settings-field">
          <select
            id="animation-select"
            value={animationDuration}
            onChange={handleAnimationChange}
          >
            <option value={0}>{t('settings.pieceAnimationNone')}</option>
            <option value={100}>{t('settings.pieceAnimationFast')}</option>
            <option value={200}>{t('settings.pieceAnimationNormal')}</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2>{t('settings.sound')}</h2>
        <div className="settings-field">
          <label htmlFor="sound-toggle">{t('settings.soundEffects')}</label>
          <input
            id="sound-toggle"
            type="checkbox"
            checked={!muted}
            onChange={toggleMute}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>{t('settings.blockedPlayers', 'Blocked Players')}</h2>
        {blocked.length === 0 ? (
          <p className="settings-empty">{t('settings.noBlocked', 'No blocked players')}</p>
        ) : (
          <div className="settings-blocked-list">
            {blocked.map((b) => (
              <div key={b.id} className="settings-blocked-item">
                <Link to={`/player/${b.username}`} className="settings-blocked-name">{b.username}</Link>
                <button className="settings-unblock-btn" onClick={() => handleUnblock(b.id)}>
                  {t('settings.unblock', 'Unblock')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
