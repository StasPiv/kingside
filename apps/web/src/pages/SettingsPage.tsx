import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { Locale } from '@kingside/shared';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  const handleLanguageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locale = e.target.value as Locale;
    i18n.changeLanguage(locale);
    localStorage.setItem('locale', locale);
    await api.patch('/api/users/me', { locale });
  };

  return (
    <div className="settings-page">
      <h1>{t('settings.title')}</h1>
      <section>
        <label htmlFor="language-select">{t('settings.language')}</label>
        <select
          id="language-select"
          value={i18n.language}
          onChange={handleLanguageChange}
        >
          <option value="en">{t('settings.english')}</option>
          <option value="ru">{t('settings.russian')}</option>
        </select>
      </section>
    </div>
  );
}
