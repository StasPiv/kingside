import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { GuessSubNav } from '../components/guess/GuessSubNav';
import { GuessStatsCards } from '../components/guess/GuessStatsCards';
import { GuessTrendsChart } from '../components/guess/GuessTrendsChart';
import { GuessBreakdowns } from '../components/guess/GuessBreakdowns';

/**
 * KS-3510 (ADR-093 §3) — `/guess/stats`. По образцу
 * `PrecisionStatsPage`: SubNav + Cards + Trends + Breakdowns. Гостям —
 * CTA на /login (эндпоинты под JwtAuthGuard).
 */
export function GuessStatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="guess-stats-page"
      data-testid="guess-stats-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <GuessSubNav />

      <header className="guess-stats-page__header">
        <h1 className="guess-stats-page__title">
          {t('guess.stats.title', 'Guess progress')}
        </h1>
      </header>

      {isGuest && (
        <section
          className="guess-stats-page__guest"
          data-testid="guess-stats-guest-cta"
        >
          <p className="guess-stats-page__guest-message">
            {t(
              'guess.stats.guest.message',
              'Sign in to track your accuracy, trends and verdict breakdown.',
            )}
          </p>
          <Link
            to="/login"
            className="guess-stats-page__guest-cta"
            data-testid="guess-stats-guest-cta-link"
          >
            {t('guess.stats.guest.cta', 'Sign in and start training')}
          </Link>
        </section>
      )}

      {!isGuest && (
        <>
          <GuessStatsCards />
          <GuessTrendsChart />
          <GuessBreakdowns />
        </>
      )}
    </div>
  );
}
