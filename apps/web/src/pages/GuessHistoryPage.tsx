import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { GuessSubNav } from '../components/guess/GuessSubNav';
import { GuessHistoryList } from '../components/guess/GuessHistoryList';

/**
 * KS-3510 (ADR-093 §3.4) — `/guess/history`. Список finished-сессий
 * с пагинацией. По образцу `PrecisionHistoryPage`.
 */
export function GuessHistoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="guess-history-page"
      data-testid="guess-history-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <GuessSubNav />

      <header className="guess-history-page__header">
        <h1 className="guess-history-page__title">
          {t('guess.history.title', 'Guess history')}
        </h1>
        <Link
          to="/guess"
          className="guess-history-page__start-cta"
          data-testid="guess-history-start-cta"
        >
          {t('guess.history.startCta', 'Start a new session')}
        </Link>
      </header>

      {isGuest && (
        <section
          className="guess-history-page__guest"
          data-testid="guess-history-guest-cta"
        >
          <p>
            {t(
              'guess.history.guest.message',
              'Sign in to see your finished sessions.',
            )}
          </p>
          <Link
            to="/login"
            className="guess-history-page__guest-cta"
            data-testid="guess-history-guest-cta-link"
          >
            {t('guess.history.guest.cta', 'Sign in and start training')}
          </Link>
        </section>
      )}

      {!isGuest && <GuessHistoryList />}
    </div>
  );
}
