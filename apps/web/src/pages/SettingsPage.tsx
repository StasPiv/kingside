import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { Locale } from '@kingside/shared';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locale = e.target.value as Locale;
    i18n.changeLanguage(locale);
    localStorage.setItem('locale', locale);
    await api.patch('/api/users/me/settings', { locale });
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.passwordMismatch'));
      return;
    }

    setPasswordLoading(true);
    try {
      await api.patch('/api/users/me/password', { currentPassword, newPassword });
      setPasswordSuccess(t('settings.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : t('settings.passwordError'));
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <div className="settings-page">
      <h1>{t('settings.title')}</h1>

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
        <h2>{t('settings.changePassword')}</h2>
        <form className="settings-form" onSubmit={handlePasswordSubmit}>
          {passwordError && <div className="error">{passwordError}</div>}
          {passwordSuccess && <div className="success">{passwordSuccess}</div>}
          <div className="settings-field">
            <label>{t('settings.currentPassword')}</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div className="settings-field">
            <label>{t('settings.newPassword')}</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="settings-field">
            <label>{t('settings.confirmNewPassword')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={passwordLoading}>
            {passwordLoading ? t('settings.updatingPassword') : t('settings.updatePassword')}
          </button>
        </form>
      </section>
    </div>
  );
}
