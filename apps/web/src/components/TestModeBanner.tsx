import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const LS_KEY = 'testBannerDismissed';

export function TestModeBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_KEY) === 'true');

  if (import.meta.env.VITE_TEST_MODE !== 'true' || dismissed) return null;

  return (
    <div className="test-mode-banner">
      <span>
        {t('testMode.message', 'Site is in test mode. Feedback and suggestions')}
        {' — '}
        <Link to="/feedback">{t('testMode.feedbackLink', 'feedback form')}</Link>
      </span>
      <button
        className="test-mode-banner__close"
        onClick={() => { localStorage.setItem(LS_KEY, 'true'); setDismissed(true); }}
        aria-label="Close"
      >
        &times;
      </button>
    </div>
  );
}
