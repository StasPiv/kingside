import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { BlindBoardSubNav } from '../components/blindBoard/BlindBoardSubNav';
import { BlindBoardHistoryList } from '../components/blindBoard/BlindBoardHistoryList';

/**
 * KS-3511 (ADR-093 §4.4) — `/blind-board/history`. Список finished-
 * сессий с cursor-пагинацией.
 */
export function BlindBoardHistoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="blind-board-history-page"
      data-testid="blind-board-history-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <BlindBoardSubNav />

      <header className="blind-board-history-page__header">
        <h1 className="blind-board-history-page__title">
          {t('blindBoard.history.title', 'Blind board history')}
        </h1>
        <Link
          to="/blind-board"
          className="blind-board-history-page__start-cta"
          data-testid="blind-board-history-start-cta"
        >
          {t('blindBoard.history.startCta', 'Start a new session')}
        </Link>
      </header>

      {isGuest && (
        <section
          className="blind-board-history-page__guest"
          data-testid="blind-board-history-guest-cta"
        >
          <p>
            {t(
              'blindBoard.history.guest.message',
              'Sign in to see your finished sessions.',
            )}
          </p>
          <Link
            to="/login"
            className="blind-board-history-page__guest-cta"
            data-testid="blind-board-history-guest-cta-link"
          >
            {t(
              'blindBoard.history.guest.cta',
              'Sign in and start training',
            )}
          </Link>
        </section>
      )}

      {!isGuest && <BlindBoardHistoryList />}
    </div>
  );
}
