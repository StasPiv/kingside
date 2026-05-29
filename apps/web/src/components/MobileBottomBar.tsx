import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAdminStatus } from '../hooks/useAdminStatus';
import { useAuth } from '../context/AuthContext';
import {
  NAV_ROUTES,
  useTopNavStats,
  DEFAULT_TOP,
  type NavRoute,
} from '../hooks/useNavStats';
import { FeedbackModal } from './FeedbackModal';

/**
 * KS-2373 → KS-2806 (ADR-058 §5.1, §6.3 T9).
 *
 * Mobile bottom bar: 3 динамических кнопки + «Ещё» (drawer).
 * После KS-2805 whitelist сузился до 6 групп (`play`/`train`/`learn`/
 * `analyze`/`broadcasts`/`profile`), легаси-ключи (puzzles, drills,
 * tournaments, workshop, archive, precision) удалены — теперь bar
 * показывает только групповые ссылки, под капотом ведёт на лобби-
 * страницы `/train` и `/analyze`.
 *
 * Источник топа — `useTopNavStats(3)` (GET `/user/nav-stats/top`).
 * При пустом ответе / loading / unauth → `DEFAULT_TOP = ['play','train',
 * 'learn']`. Затем добор недостающих из `DEFAULT_TOP` и общего списка
 * групп (extreme case — все флаги off, чтобы bar не оказался пустым).
 *
 * «Ещё» (drawer-разметка) — заглушка с базовыми ссылками. Полная
 * группировка «Социум / Аккаунт / Помощь / Админ» — следующий тикет
 * KS-2807 (T10).
 */

export function MobileBottomBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  // KS-2807: feedback-модалка (как в Sidebar). Кнопка лежит в группе
  // «Помощь» drawer'а, открывает тот же `<FeedbackModal>`.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // KS-2806: gate-функция группы. Для `train` имеет смысл показывать
  // только если хотя бы один подраздел открыт (Rush, puzzles или
  // drills). Если backend `customGate` уже определён в NAV_ROUTES —
  // используем его, иначе fallback на `flag`.
  const { flags } = useFeatureFlags();
  const { isAdmin } = useAdminStatus();
  const { user } = useAuth();
  const isRouteVisible = (route: NavRoute): boolean => {
    const meta = NAV_ROUTES[route];
    if (meta.customGate) return meta.customGate(flags);
    if (meta.flag === null) return true;
    return Boolean(flags[meta.flag]);
  };

  // KS-2373: top-N от backend (KS-2809 уже агрегирует legacy→group).
  const { routes: topFromApi } = useTopNavStats(3);

  const topRoutes = useMemo<NavRoute[]>(() => {
    // 1. Берём backend-топ если он непустой, иначе DEFAULT_TOP.
    const candidate = topFromApi.length > 0 ? topFromApi : DEFAULT_TOP;
    // 2. Фильтруем по видимости (feature-flag / customGate).
    const filtered = candidate.filter(isRouteVisible);
    if (filtered.length >= 3) return filtered.slice(0, 3);
    // 3. Добор из DEFAULT_TOP без дубликатов.
    const result = [...filtered];
    for (const r of DEFAULT_TOP) {
      if (result.length >= 3) break;
      if (!result.includes(r) && isRouteVisible(r)) result.push(r);
    }
    // 4. Добор из остальных групп — на случай когда DEFAULT_TOP-группа
    // выключена feature-flag'ом.
    for (const r of Object.keys(NAV_ROUTES) as NavRoute[]) {
      if (result.length >= 3) break;
      if (!result.includes(r) && isRouteVisible(r)) result.push(r);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topFromApi, flags]);

  const moreRoutes = useMemo<NavRoute[]>(() => {
    return (Object.keys(NAV_ROUTES) as NavRoute[]).filter(
      (r) => !topRoutes.includes(r) && isRouteVisible(r),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topRoutes, flags]);

  const isActive = (paths: string[]) =>
    paths.some(
      (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
    );

  return (
    <div className="mobile-bottom-bar" data-testid="mobile-bottom-bar">
      {topRoutes.map((route) => {
        const meta = NAV_ROUTES[route];
        // KS-2806 (regression guard): NAV_ROUTES в принципе должен
        // содержать все 6 групп, но если backend по какой-то причине
        // вернёт совсем странный ключ — пропускаем, не падаем.
        if (!meta) return null;
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
              {/* KS-2544: предпочитаем короткое название (если задано). */}
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
          {/* KS-2807 (ADR-058 §5.2): drawer группирован по семантике.
              «Разделы» — группы из NAV_ROUTES, которые не попали в
              top-3 (например, train/learn/analyze/play), но НЕ
              broadcasts/profile (они переехали в группы «Социум»
              и «Аккаунт» ниже).

              Каждая видимая группа — заголовок + ссылки. Группа без
              видимых пунктов (все элементы скрыты по auth/flag)
              целиком не рендерится. */}

          {/* — Разделы (group-routes не в top-3, кроме broadcasts/profile) — */}
          {/* KS-3425: пункт «Угадай ход» отсюда удалён — основная точка
              входа теперь карточка в /train (KS-3423, TrainLobbyPage).
              Поведение группы вернули к исходному: если sectionRoutes
              пуст — секция не рендерится. */}
          {(() => {
            const sectionRoutes = moreRoutes.filter(
              (r) => r !== 'broadcasts' && r !== 'profile',
            );
            if (sectionRoutes.length === 0) return null;
            return (
              <div
                className="mobile-more-group"
                data-testid="mobile-more-group-sections"
              >
                <div className="mobile-more-group__title">
                  {t('nav.moreSections', 'Sections')}
                </div>
                {sectionRoutes.map((route) => {
                  const meta = NAV_ROUTES[route];
                  if (!meta) return null;
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
              </div>
            );
          })()}

          {/* — Социум — */}
          {(() => {
            const broadcastsItem =
              moreRoutes.includes('broadcasts') ? (
                <Link
                  key="broadcasts"
                  to="/broadcasts"
                  data-testid="mobile-more-broadcasts"
                >
                  {t('nav.tv', 'TV')}
                </Link>
              ) : null;
            const friendsItem = user ? (
              <Link
                key="friends"
                to="/friends"
                data-testid="mobile-more-friends"
              >
                {t('nav.friends', 'Friends')}
              </Link>
            ) : null;
            if (!broadcastsItem && !friendsItem) return null;
            return (
              <div
                className="mobile-more-group"
                data-testid="mobile-more-group-social"
              >
                <div className="mobile-more-group__title">
                  {t('nav.moreSocial', 'Social')}
                </div>
                {broadcastsItem}
                {friendsItem}
              </div>
            );
          })()}

          {/* — Аккаунт — */}
          {(() => {
            const profileItem =
              user && moreRoutes.includes('profile') ? (
                <Link
                  key="profile"
                  to="/profile"
                  data-testid="mobile-more-profile"
                >
                  {t('nav.profile', 'Profile')}
                </Link>
              ) : null;
            const settingsItem = user ? (
              <Link
                key="settings"
                to="/settings"
                data-testid="mobile-more-settings"
              >
                {t('nav.settings', 'Settings')}
              </Link>
            ) : null;
            if (!profileItem && !settingsItem) return null;
            return (
              <div
                className="mobile-more-group"
                data-testid="mobile-more-group-account"
              >
                <div className="mobile-more-group__title">
                  {t('nav.moreAccount', 'Account')}
                </div>
                {profileItem}
                {settingsItem}
              </div>
            );
          })()}

          {/* — Помощь — */}
          <div
            className="mobile-more-group"
            data-testid="mobile-more-group-help"
          >
            <div className="mobile-more-group__title">
              {t('nav.moreHelp', 'Help')}
            </div>
            <Link to="/features" data-testid="mobile-more-features">
              {t('nav.features', 'Features')}
            </Link>
            {/* KS-2807: Feedback — модалка, как в Sidebar (не страница).
                Кнопка-«ссылка» внутри drawer'а; click останавливаем,
                чтобы drawer не закрылся одновременно с открытием
                модалки (drawer закрывает onClick на родителе). */}
            <button
              type="button"
              className="mobile-more-feedback-btn"
              data-testid="mobile-more-feedback"
              onClick={(e) => {
                e.stopPropagation();
                setFeedbackOpen(true);
                setMoreOpen(false);
              }}
            >
              {t('feedback.title', 'Feedback')}
            </button>
          </div>

          {/* — Админ (только для админов) — */}
          {isAdmin && (
            <div
              className="mobile-more-group"
              data-testid="mobile-more-group-admin"
            >
              <div className="mobile-more-group__title">
                {t('nav.moreAdmin', 'Admin')}
              </div>
              <Link
                to="/admin/feature-flags"
                data-testid="mobile-more-admin"
              >
                {t('nav.admin', 'Admin')}
              </Link>
            </div>
          )}
        </div>
      )}
      {feedbackOpen && (
        <FeedbackModal onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
  );
}
