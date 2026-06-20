import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../context/AuthContext';

/**
 * KS-4358 / ADR-136 T6. Общая подвигация раздела «Точность» на новой
 * схеме `tactic_puzzles`. Образец — `PrecisionSubNav` (KS-2743 /
 * ADR-057 §3). Стиль наследуется через общий CSS-класс
 * `.precision-subnav` — единый внешний вид с `/precision`.
 *
 * Пункты:
 *   - «Каталог» → `/critical-moment`;
 *   - «История» → `/critical-moment/history` (auth-only);
 *   - «Статистика» → `/critical-moment/stats` (auth-only);
 *   - «Ошибки» → `/critical-moment/mistakes` (auth-only).
 *
 * Гостю показывается только «Каталог»: остальные разделы требуют
 * авторизации и backend всё равно отдаст 401. Активный пункт
 * определяется по `useLocation().pathname` (точное совпадение).
 *
 * Сложные popover'ы (`ⓘ` + `⋮`) из `PrecisionSubNav` пока не
 * переносим — у /critical-moment нет CTA «Генерация из PGN», intro
 * берётся прямо на странице. Если будут нужны — добавим тем же
 * паттерном отдельной задачей.
 */
type SubNavItem = {
  readonly path: string;
  readonly i18nKey: string;
  readonly fallback: string;
  readonly testKey: 'catalog' | 'history' | 'stats' | 'mistakes';
  readonly authOnly: boolean;
};

const ITEMS: readonly SubNavItem[] = [
  {
    path: '/critical-moment',
    i18nKey: 'tacticPuzzle.subnav.catalog',
    fallback: 'Catalog',
    testKey: 'catalog',
    authOnly: false,
  },
  {
    path: '/critical-moment/history',
    i18nKey: 'tacticPuzzle.subnav.history',
    fallback: 'History',
    testKey: 'history',
    authOnly: true,
  },
  {
    path: '/critical-moment/stats',
    i18nKey: 'tacticPuzzle.subnav.stats',
    fallback: 'Stats',
    testKey: 'stats',
    authOnly: true,
  },
  {
    path: '/critical-moment/mistakes',
    i18nKey: 'tacticPuzzle.subnav.mistakes',
    fallback: 'Mistakes',
    testKey: 'mistakes',
    authOnly: true,
  },
];

export function TacticPuzzlesSubNav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const isGuest = !user;

  const visibleItems = ITEMS.filter((item) => !item.authOnly || !isGuest);

  return (
    <nav
      className="precision-subnav tactic-puzzles-subnav"
      role="tablist"
      aria-label={t('tacticPuzzle.subnav.label', 'Critical Moment sections')}
      data-testid="tactic-puzzles-subnav"
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
            className={`precision-subnav__item${active ? ' precision-subnav__item--active' : ''}`}
            data-testid={`tactic-puzzles-subnav-${item.testKey}`}
            data-active={active ? 'true' : 'false'}
          >
            {t(item.i18nKey, item.fallback)}
          </Link>
        );
      })}
    </nav>
  );
}
