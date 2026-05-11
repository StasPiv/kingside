import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-2743 / ADR-057 §3, §4, §5, §6 — общий sub-nav для раздела
 * «Тренировка точности». Раздел разбит на 3 страницы:
 *   - `/precision`         — тренировка (главная);
 *   - `/precision/stats`   — статистика (тренд + breakdowns);
 *   - `/precision/history` — история попыток.
 *
 * Этот компонент рендерит общую ленту вкладок сверху каждой из этих
 * страниц. Активный пункт определяется по `useLocation()` (точное
 * совпадение `pathname`). Внутренние страницы `/precision/attempts/:id`
 * не подсвечивают ни один пункт — таб-набор намеренно «отпущен», т.к.
 * это deep-страница попытки, не входящая в верхне-уровневую IA.
 *
 * Гостям (без auth) пункты «Прогресс» и «История» скрыты — обе страницы
 * показывают персональные данные текущего пользователя (см. ADR-057 §3,
 * §6 и ADR-056 §2.2 / §2.3 — оба ходят в `/precision/...(me)`-эндпоинты).
 *
 * # DOM
 *
 *   <nav class="precision-subnav" role="tablist"
 *        data-testid="precision-subnav">
 *     <a class="precision-subnav__item[ --active]"
 *        role="tab" aria-selected="true|false"
 *        data-testid="precision-subnav-training|progress|history"
 *        data-active="true|false" href="…">Текст</a>
 *     …
 *   </nav>
 *
 * # i18n
 *
 *   precision.subnav.training — «Тренировка» / Training
 *   precision.subnav.progress — «Прогресс»  / Progress
 *   precision.subnav.history  — «История»   / History
 *   precision.subnav.label    — aria-label для `<nav>` / role=tablist
 *
 * # Использование
 *
 *   import { PrecisionSubNav } from '../components/precision/PrecisionSubNav';
 *   …
 *   return (
 *     <>
 *       <PrecisionSubNav />
 *       …content…
 *     </>
 *   );
 *
 * NB: подключение к страницам — задачи F2/F3/F4 (KS-2744/KS-2745/
 * KS-2746). В KS-2743 только сам компонент + i18n + тесты.
 */

type SubNavItem = {
  /** Путь точного совпадения для активного состояния. */
  readonly path: string;
  /** Ключ i18n. Fallback задан рядом, чтобы не падать на отсутствии. */
  readonly i18nKey: string;
  readonly fallback: string;
  /** Стабильный test-id-суффикс. */
  readonly testKey: 'training' | 'progress' | 'history';
  /** Виден только аутентифицированным. */
  readonly authOnly: boolean;
};

const ITEMS: readonly SubNavItem[] = [
  {
    path: '/precision',
    i18nKey: 'precision.subnav.training',
    fallback: 'Training',
    testKey: 'training',
    authOnly: false,
  },
  {
    path: '/precision/stats',
    i18nKey: 'precision.subnav.progress',
    fallback: 'Progress',
    testKey: 'progress',
    authOnly: true,
  },
  {
    path: '/precision/history',
    i18nKey: 'precision.subnav.history',
    fallback: 'History',
    testKey: 'history',
    authOnly: true,
  },
];

export function PrecisionSubNav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const isGuest = !user;

  const visibleItems = ITEMS.filter((item) => !item.authOnly || !isGuest);

  return (
    <nav
      className="precision-subnav"
      role="tablist"
      aria-label={t('precision.subnav.label', 'Precision sections')}
      data-testid="precision-subnav"
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
            data-testid={`precision-subnav-${item.testKey}`}
            data-active={active ? 'true' : 'false'}
          >
            {t(item.i18nKey, item.fallback)}
          </Link>
        );
      })}
    </nav>
  );
}
