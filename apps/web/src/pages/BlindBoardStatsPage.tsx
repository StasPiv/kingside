import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { BlindBoardSubNav } from '../components/blindBoard/BlindBoardSubNav';
import { BlindBoardStatsCards } from '../components/blindBoard/BlindBoardStatsCards';
import { BlindBoardTrendsChart } from '../components/blindBoard/BlindBoardTrendsChart';
import { BlindBoardBreakdowns } from '../components/blindBoard/BlindBoardBreakdowns';
import { PageSeo } from '../components/seo/PageSeo';

/**
 * KS-3511 (ADR-093 §4) — `/blind-board/stats`. SubNav + Cards + Trends
 * + Breakdowns. Маршрут под ProtectedRoute.
 */
export function BlindBoardStatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="blind-board-stats-page"
      data-testid="blind-board-stats-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <PageSeo ns="blindBoard.stats" path="/blind-board/stats" noindex />
      <BlindBoardSubNav />

      <header className="blind-board-stats-page__header">
        <h1 className="blind-board-stats-page__title">
          {t('blindBoard.stats.title', 'Blind board progress')}
        </h1>
      </header>

      {isGuest && (
        <section
          className="blind-board-stats-page__guest"
          data-testid="blind-board-stats-guest-cta"
        >
          <p>
            {t(
              'blindBoard.stats.guest.message',
              'Sign in to track your streak, level and piece-type breakdown.',
            )}
          </p>
          <Link
            to="/login"
            className="blind-board-stats-page__guest-cta"
            data-testid="blind-board-stats-guest-cta-link"
          >
            {t(
              'blindBoard.stats.guest.cta',
              'Sign in and start training',
            )}
          </Link>
        </section>
      )}

      {!isGuest && (
        <>
          <BlindBoardStatsCards />
          <BlindBoardTrendsChart />
          <BlindBoardBreakdowns />
        </>
      )}
    </div>
  );
}
