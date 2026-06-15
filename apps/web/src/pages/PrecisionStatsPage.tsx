import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { PrecisionSubNav } from '../components/precision/PrecisionSubNav';
import { PrecisionStatsCards } from '../components/precision/PrecisionStatsCards';
import { PrecisionTrendsChart } from '../components/precision/PrecisionTrendsChart';
import { PrecisionBreakdowns } from '../components/precision/PrecisionBreakdowns';
import { PageSeo } from '../components/seo/PageSeo';

/**
 * KS-2744 / ADR-057 §3 — страница `/precision/stats`. Подробная
 * статистика тренировки точности (вынесена с главной `/precision`,
 * чтобы освободить первый экран под сетку позиций).
 *
 * Компоненты:
 *   - `<PrecisionSubNav />`            — общая навигация (KS-2743).
 *   - `<PrecisionStatsCards />`        — 4 top-карточки агрегатов
 *                                        (`/precision/stats/me`).
 *   - `<PrecisionTrendsChart />`       — тренд accuracy
 *                                        (`/precision/trends/me?bucket=`).
 *   - `<PrecisionBreakdowns />`        — фазы игры + слабые темы
 *                                        (`/precision/breakdowns/me`).
 *
 * Все backend-эндпоинты — без изменений (ADR-056 §2.1/§2.3, бэкенд
 * KS-2718/2727/2728). Новых метрик не вводим, только перенос.
 *
 * Гостям показываем CTA «Войти и начать тренироваться» вместо
 * пустых блоков — эндпоинты статистики `/me`-only, без auth бесполезны.
 *
 * Регистрация роута — задача F5 (KS-2747). Эта страница только
 * экспортируется отсюда; App.tsx ещё не подключает.
 *
 * # DOM
 *   <div class="precision-stats-page" data-testid="precision-stats-page"
 *        data-auth="guest|user">
 *     <PrecisionSubNav />
 *     <header class="precision-stats-page__header">
 *       <h1>…title…</h1>
 *     </header>
 *
 *     // guest:
 *     <section class="precision-stats-page__guest"
 *              data-testid="precision-stats-guest-cta">…</section>
 *
 *     // user:
 *     <PrecisionStatsCards />
 *     <PrecisionTrendsChart />
 *     <PrecisionBreakdowns />
 *   </div>
 */
export function PrecisionStatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="precision-stats-page"
      data-testid="precision-stats-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <PageSeo ns="precision.stats" path="/precision/stats" noindex />
      <PrecisionSubNav />

      <header className="precision-stats-page__header">
        <h1 className="precision-stats-page__title">
          {t('precision.stats.title', 'Precision progress')}
        </h1>
      </header>

      {isGuest && (
        <section
          className="precision-stats-page__guest"
          data-testid="precision-stats-guest-cta"
        >
          <p className="precision-stats-page__guest-message">
            {t(
              'precision.stats.guest.message',
              'Sign in to track your accuracy, trends and weak themes.',
            )}
          </p>
          <Link
            to="/login"
            className="precision-stats-page__guest-cta"
            data-testid="precision-stats-guest-cta-link"
          >
            {t(
              'precision.stats.guest.cta',
              'Sign in and start training',
            )}
          </Link>
        </section>
      )}

      {!isGuest && (
        <>
          <PrecisionStatsCards />
          <PrecisionTrendsChart />
          <PrecisionBreakdowns />
        </>
      )}
    </div>
  );
}
