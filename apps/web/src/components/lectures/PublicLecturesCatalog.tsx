/**
 * KS-4192 / ADR-128 §7.6.1.2 L1.UI. Каталог публичных лекций.
 *
 * Режимы:
 *  - `full` — гостевая страница `/lectures` или авторизованный
 *    `/lectures?view=discover`. Семь блоков по §L1.UI.2:
 *      1. Hero;
 *      2. inline guest-CTA баннер (только для гостей);
 *      3. вкладки All / Live / Scheduled / Recorded;
 *      4. грид карточек (`live → scheduled ASC → recorded DESC` —
 *         сортировка делается на бэке KS-4188; здесь только рендер);
 *      5. «Show more» (limit=24);
 *      6. empty-state;
 *      7. единый error-state.
 *  - `preview` — мини-блок «Discover public lectures» в авторизованном
 *    `/lectures`: без hero/баннера/вкладок/Show more, ограниченное число
 *    карточек + «See all» → `/lectures?view=discover`.
 *
 * Строки `lecturesPublic.*` — задача marketing'а KS-4190-MK. До их
 * готовности — плейсхолдеры на английском через `defaultValue`.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { usePublicLectures } from '../../hooks/usePublicLectures';
import type { PublicLectureStatusFilter } from '../../api/publicLectures';
import { PublicLectureCard } from './PublicLectureCard';

export type PublicLecturesCatalogMode = 'full' | 'preview';

export interface PublicLecturesCatalogProps {
  mode: PublicLecturesCatalogMode;
  /** Лимит карточек на одну страницу (full=24, preview=6). */
  limit?: number;
  /**
   * Показывать ли гостевой CTA баннер. По умолчанию — только в full
   * режиме у гостей; авторизованные с `?view=discover` его не видят.
   */
  showGuestCta?: boolean;
}

const FULL_LIMIT = 24;
const PREVIEW_LIMIT = 6;

const TABS: { id: PublicLectureStatusFilter; key: string; fallback: string }[] =
  [
    { id: 'all', key: 'lecturesPublic.tabAll', fallback: 'All' },
    { id: 'live', key: 'lecturesPublic.tabLive', fallback: 'Live' },
    { id: 'scheduled', key: 'lecturesPublic.tabScheduled', fallback: 'Scheduled' },
    { id: 'recorded', key: 'lecturesPublic.tabRecorded', fallback: 'Recorded' },
  ];

export function PublicLecturesCatalog({
  mode,
  limit,
  showGuestCta = mode === 'full',
}: PublicLecturesCatalogProps) {
  const { t } = useTranslation();
  const effectiveLimit = limit ?? (mode === 'full' ? FULL_LIMIT : PREVIEW_LIMIT);
  const state = usePublicLectures({ limit: effectiveLimit });

  // Единый error-state (§L1.UI.7): вместо четырёх «Failed to load»
  // показываем одно сообщение с retry.
  if (state.error && state.items.length === 0) {
    return (
      <section
        className="public-lectures-catalog public-lectures-catalog--error"
        data-testid="public-lectures-error"
      >
        <p className="public-lectures-catalog__error-text">
          {t(
            'lecturesPublic.errorLoadFailed',
            'Could not load lectures. Please try again later.',
          )}
        </p>
        <button
          type="button"
          className="public-lectures-catalog__retry"
          onClick={state.reload}
        >
          {t('lecturesPublic.retry', 'Retry')}
        </button>
      </section>
    );
  }

  const grid = (
    <div
      className="public-lectures-catalog__grid"
      data-testid="public-lectures-grid"
    >
      {state.items.map((lecture) => (
        <PublicLectureCard key={lecture.id} lecture={lecture} />
      ))}
    </div>
  );

  if (mode === 'preview') {
    return (
      <section
        className="public-lectures-catalog public-lectures-catalog--preview"
        data-testid="public-lectures-catalog-preview"
      >
        <header className="public-lectures-catalog__preview-header">
          <h2 className="public-lectures-catalog__preview-title">
            {t(
              'lecturesPublic.discoverTitle',
              'Discover public lectures',
            )}
          </h2>
          <Link
            to="/lectures?view=discover"
            className="public-lectures-catalog__see-all"
          >
            {t('lecturesPublic.seeAll', 'See all')}
          </Link>
        </header>
        {state.loading ? (
          <p className="public-lectures-catalog__loading">
            {t('lecturesPublic.loading', 'Loading…')}
          </p>
        ) : state.items.length === 0 ? (
          <p className="public-lectures-catalog__empty">
            {t(
              'lecturesPublic.emptyPreview',
              'No public lectures yet — check back soon.',
            )}
          </p>
        ) : (
          grid
        )}
      </section>
    );
  }

  // mode === 'full'
  return (
    <section
      className="public-lectures-catalog public-lectures-catalog--full"
      data-testid="public-lectures-catalog-full"
    >
      <header className="public-lectures-catalog__hero">
        <h1 className="public-lectures-catalog__hero-title">
          {t('lecturesPublic.heroTitle', 'Chess lectures and coaches')}
        </h1>
        <p className="public-lectures-catalog__hero-subtitle">
          {t(
            'lecturesPublic.heroSubtitle',
            'Live and recorded chess lectures by titled coaches.',
          )}
        </p>
      </header>

      {showGuestCta && (
        <div
          className="public-lectures-catalog__guest-cta"
          data-testid="public-lectures-guest-cta"
        >
          <p>
            {t(
              'lecturesPublic.guestCta',
              'Sign in to book lectures and get live access.',
            )}
          </p>
          <Link
            to="/login"
            className="public-lectures-catalog__guest-cta-link"
          >
            {t('lecturesPublic.guestCtaLink', 'Sign in')}
          </Link>
        </div>
      )}

      <nav
        className="public-lectures-catalog__tabs"
        role="tablist"
        aria-label={t('lecturesPublic.tabsAriaLabel', 'Filter lectures by status')}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={state.status === tab.id}
            className={`public-lectures-catalog__tab${state.status === tab.id ? ' public-lectures-catalog__tab--active' : ''}`}
            data-testid={`public-lectures-tab-${tab.id}`}
            onClick={() => state.setStatus(tab.id)}
          >
            {t(tab.key, tab.fallback)}
          </button>
        ))}
      </nav>

      {state.loading ? (
        <p
          className="public-lectures-catalog__loading"
          data-testid="public-lectures-loading"
        >
          {t('lecturesPublic.loading', 'Loading…')}
        </p>
      ) : state.items.length === 0 ? (
        <p
          className="public-lectures-catalog__empty"
          data-testid="public-lectures-empty"
        >
          {t('lecturesPublic.empty', 'No lectures match the current filter.')}
        </p>
      ) : (
        <>
          {grid}
          {state.hasMore && (
            <div className="public-lectures-catalog__show-more">
              <button
                type="button"
                className="public-lectures-catalog__show-more-btn"
                onClick={state.loadMore}
                disabled={state.loadingMore}
                data-testid="public-lectures-show-more"
              >
                {state.loadingMore
                  ? t('lecturesPublic.loadingMore', 'Loading…')
                  : t('lecturesPublic.showMore', 'Show more')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
