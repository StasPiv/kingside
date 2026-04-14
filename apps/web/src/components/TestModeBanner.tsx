import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FeedbackModal } from './FeedbackModal';

const LS_KEY = 'testBannerDismissed';

export function TestModeBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_KEY) === 'true');
  const [showFeedback, setShowFeedback] = useState(false);

  if (import.meta.env.VITE_TEST_MODE !== 'true' || dismissed) return null;

  return (
    <>
      <div className="test-mode-banner">
        <span>
          {t('testMode.message', 'Site is in test mode. Feedback and suggestions')}
          {' — '}
          <a href="#" onClick={(e) => { e.preventDefault(); setShowFeedback(true); }}>
            {t('testMode.feedbackLink', 'feedback form')}
          </a>
        </span>
        <button
          className="test-mode-banner__close"
          onClick={() => { localStorage.setItem(LS_KEY, 'true'); setDismissed(true); }}
          aria-label="Close"
        >
          &times;
        </button>
      </div>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </>
  );
}
