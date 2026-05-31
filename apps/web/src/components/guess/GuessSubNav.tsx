import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-3510 (ADR-093 §F-guess) — sub-nav «Угадай ход». Три вкладки:
 *   - `/guess`         — Training (доступно гостю + авторизованному).
 *   - `/guess/stats`   — Progress (auth-only, статистика).
 *   - `/guess/history` — History (auth-only, история сессий).
 *
 * Сделан по образцу `PrecisionSubNav` (KS-2743). Mobile-actions
 * (ⓘ + ⋮) НЕ добавлял — у guess нет отдельных popover-actions, а
 * intro на лендинге короткий и виден сразу. Если появятся —
 * расширим позже без ломки контракта (новый optional prop).
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
    path: '/guess',
    i18nKey: 'guess.subnav.training',
    fallback: 'Training',
    testKey: 'training',
    authOnly: false,
  },
  {
    path: '/guess/stats',
    i18nKey: 'guess.subnav.progress',
    fallback: 'Progress',
    testKey: 'progress',
    authOnly: true,
  },
  {
    path: '/guess/history',
    i18nKey: 'guess.subnav.history',
    fallback: 'History',
    testKey: 'history',
    authOnly: true,
  },
];

export function GuessSubNav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const isGuest = !user;

  const visibleItems = ITEMS.filter((item) => !item.authOnly || !isGuest);

  return (
    <nav
      className="guess-subnav"
      role="tablist"
      aria-label={t('guess.subnav.label', 'Guess sections')}
      data-testid="guess-subnav"
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
            className={`guess-subnav__item${active ? ' guess-subnav__item--active' : ''}`}
            data-testid={`guess-subnav-${item.testKey}`}
            data-active={active ? 'true' : 'false'}
          >
            {t(item.i18nKey, item.fallback)}
          </Link>
        );
      })}
    </nav>
  );
}
