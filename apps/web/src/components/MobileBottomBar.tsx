import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag } from '../context/FeatureFlagsContext';
import { useAdminStatus } from '../hooks/useAdminStatus';
import {
  NAV_ROUTES,
  useTopNavStats,
  type NavRoute,
} from '../hooks/useNavStats';

/**
 * KS-2373: top-3 в нижнем баре больше не зашит хардкодом — он
 * подтягивается из `GET /user/nav-stats/top?limit=3`. Если
 * пользователь часто заходит в /drills, /drills будет в bar'е.
 *
 * Дефолт (свежий аккаунт без статистики, ошибка backend, unauth):
 *   ['play', 'tournaments', 'workshop'] — повторяет «исторический»
 *   набор кнопок до KS-2373. Дефолт также фильтруется по
 *   feature-flags: если tournamentsEnabled=false, ['play','workshop',
 *   'archive'] и т. д.
 *
 * «Ещё» (4-я кнопка) показывает все остальные whitelist-routes,
 * которые НЕ попали в top-3, плюс старые пункты вне whitelist
 * (Lessons, Friends, Settings, Feedback, Admin).
 */

const DEFAULT_TOP: NavRoute[] = ['play', 'tournaments', 'workshop'];

export function MobileBottomBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  // KS-2110: «Уроки» в mobile-навигации не было совсем — пользователю
  // на мобильном /lessons было недоступно из меню. Возвращаем пункт
  // в more-menu (с тем же runtime feature-flag, что и desktop sidebar).
  const lessonsEnabled = useFeatureFlag('lessonsEnabled');
  // KS-2218: runtime feature-flags для основных разделов.
  const tournamentsEnabled = useFeatureFlag('tournamentsEnabled');
  const puzzlesEnabled = useFeatureFlag('puzzlesEnabled');
  const broadcastsEnabled = useFeatureFlag('broadcastsEnabled');
  // KS-2235 (ADR-035 §7.2): «Тренажёры» — runtime feature-flag
  // `drillsEnabled` (KS-2231).
  const drillsEnabled = useFeatureFlag('drillsEnabled');
  // Admin-пункт по аналогии с Sidebar (KS-2109).
  const { isAdmin } = useAdminStatus();

  // KS-2373: top-3 от backend. На время загрузки и при ошибке /
  // unauth — пустой массив, фоллбек на DEFAULT_TOP.
  const { routes: topFromApi } = useTopNavStats(3);

  // Применяем feature-flag фильтр к дефолту (на случай если
  // tournamentsEnabled=false — не показываем «турниры» как один из
  // дефолтных). useTopNavStats уже сам фильтрует свой ответ.
  const flagsByRoute: Record<NavRoute, boolean> = {
    play: true,
    tournaments: tournamentsEnabled,
    workshop: true,
    lessons: lessonsEnabled,
    drills: drillsEnabled,
    broadcasts: broadcastsEnabled,
    archive: true,
    profile: true,
    puzzles: puzzlesEnabled,
    // KS-2552 / ADR-048: gate такой же как у `puzzles`. Без этой строки
    // фильтр на строке `candidate.filter((r) => flagsByRoute[r])`
    // выкидывал `precision` (undefined → falsy), даже когда backend
    // отдавал его в top-3 — mobile bar показывал старую кнопку
    // (`play` как добор из DEFAULT_TOP).
    precision: puzzlesEnabled,
  };

  const topRoutes = useMemo<NavRoute[]>(() => {
    const candidate = topFromApi.length > 0 ? topFromApi : DEFAULT_TOP;
    const filtered = candidate.filter((r) => flagsByRoute[r]);
    if (filtered.length >= 3) return filtered.slice(0, 3);
    // Добиваем недостающие из дефолтного набора (если фильтр выкинул
    // какие-то), без дубликатов.
    const result = [...filtered];
    for (const r of DEFAULT_TOP) {
      if (result.length >= 3) break;
      if (!result.includes(r) && flagsByRoute[r]) result.push(r);
    }
    // И из остальных, если всё ещё мало (extreme: все флаги off).
    for (const r of Object.keys(NAV_ROUTES) as NavRoute[]) {
      if (result.length >= 3) break;
      if (!result.includes(r) && flagsByRoute[r]) result.push(r);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    topFromApi,
    tournamentsEnabled,
    puzzlesEnabled,
    broadcastsEnabled,
    drillsEnabled,
    lessonsEnabled,
  ]);

  const moreRoutes = useMemo<NavRoute[]>(() => {
    return (Object.keys(NAV_ROUTES) as NavRoute[]).filter(
      (r) => !topRoutes.includes(r) && flagsByRoute[r],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    topRoutes,
    tournamentsEnabled,
    puzzlesEnabled,
    broadcastsEnabled,
    drillsEnabled,
    lessonsEnabled,
  ]);

  const isActive = (paths: string[]) =>
    paths.some(
      (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
    );

  return (
    <div className="mobile-bottom-bar" data-testid="mobile-bottom-bar">
      {topRoutes.map((route) => {
        const meta = NAV_ROUTES[route];
        const active = isActive(meta.matches);
        return (
          <Link
            key={route}
            to={meta.to}
            data-testid={`mobile-bar-${route}`}
            data-route={route}
            className={`mobile-bar-item${active ? ' mobile-bar-item--active' : ''}`}
          >
            <span className="mobile-bar-icon">{meta.icon}</span>
            <span className="mobile-bar-label">
              {/* KS-2544: предпочитаем короткое название (если задано),
                  чтобы в узкой mobile-bar колонке не обрезалось. */}
              {meta.labelShortKey
                ? t(meta.labelShortKey, meta.labelShortFallback ?? meta.labelFallback)
                : t(meta.labelKey, meta.labelFallback)}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        className={`mobile-bar-item${moreOpen ? ' mobile-bar-item--active' : ''}`}
        data-testid="mobile-bar-more"
        onClick={() => setMoreOpen(!moreOpen)}
      >
        <span className="mobile-bar-icon">⋯</span>
        <span className="mobile-bar-label">{t('nav.more', 'More')}</span>
      </button>
      {moreOpen && (
        <div
          className="mobile-more-menu"
          data-testid="mobile-more-menu"
          onClick={() => setMoreOpen(false)}
        >
          {moreRoutes.map((route) => {
            const meta = NAV_ROUTES[route];
            return (
              <Link
                key={route}
                to={meta.to}
                data-testid={`mobile-more-${route}`}
              >
                {t(meta.labelKey, meta.labelFallback)}
              </Link>
            );
          })}
          {/* Пункты, не попавшие в whitelist nav-stats — они «технические»,
              их частота не нужна (статистика по ним игнорируется). */}
          <Link to="/features">{t('nav.features', 'Features')}</Link>
          <Link to="/friends">{t('nav.friends', 'Friends')}</Link>
          <Link to="/feedback">{t('nav.feedback', 'Feedback')}</Link>
          <Link to="/settings">{t('nav.settings', 'Settings')}</Link>
          {isAdmin && (
            <Link to="/admin/feature-flags" data-testid="mobile-more-admin">
              {t('nav.admin', 'Admin')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
