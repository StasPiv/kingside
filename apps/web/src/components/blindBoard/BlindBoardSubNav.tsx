import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-3511 (ADR-093 §F-bb) — sub-nav «Слепая доска». 3 вкладки:
 *   - `/blind-board`         — Training
 *   - `/blind-board/stats`   — Progress (auth-only)
 *   - `/blind-board/history` — History (auth-only)
 *
 * По образцу `PrecisionSubNav` / `GuessSubNav`.
 */
type SubNavItem = {
  readonly path: string;
  readonly i18nKey: string;
  readonly fallback: string;
  readonly testKey: 'training' | 'progress' | 'history';
  readonly authOnly: boolean;
};

const ITEMS: readonly SubNavItem[] = [
  {
    path: '/blind-board',
    i18nKey: 'blindBoard.subnav.training',
    fallback: 'Training',
    testKey: 'training',
    authOnly: false,
  },
  {
    path: '/blind-board/stats',
    i18nKey: 'blindBoard.subnav.progress',
    fallback: 'Progress',
    testKey: 'progress',
    authOnly: true,
  },
  {
    path: '/blind-board/history',
    i18nKey: 'blindBoard.subnav.history',
    fallback: 'History',
    testKey: 'history',
    authOnly: true,
  },
];

export function BlindBoardSubNav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const isGuest = !user;

  const visibleItems = ITEMS.filter((item) => !item.authOnly || !isGuest);

  return (
    <nav
      className="blind-board-subnav"
      role="tablist"
      aria-label={t('blindBoard.subnav.label', 'Blind board sections')}
      data-testid="blind-board-subnav"
      data-guest={isGuest ? 'true' : 'false'}
    >
      {visibleItems.map((item) => {
        const active = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            className={`blind-board-subnav__item${active ? ' blind-board-subnav__item--active' : ''}`}
            data-testid={`blind-board-subnav-${item.testKey}`}
            data-active={active ? 'true' : 'false'}
          >
            {t(item.i18nKey, item.fallback)}
          </Link>
        );
      })}
    </nav>
  );
}
