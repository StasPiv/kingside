import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { lessonsApi } from '../api/lessonsApi';
import { CourseCard } from '../components/lessons/CourseCard';
import type { ActiveCourseSummary } from '../hooks/useLessonsHeroContext';
import { mapActiveCourses } from '../utils/activeCourseSummary';
import { resolveInlineText } from '../utils/inlineI18nText';
import { formatRelativeActivity } from '../utils/relativeTime';

/**
 * `MyActiveCoursesPage` — страница `/lessons/my-active`
 * (KS-1941 / F-4 / KS-1957 / KS-1931 §3.2 §7.3).
 *
 * Показывает все активные курсы пользователя одним списком M-карточек.
 * Источник — единый бэк-эндпоинт `lessonsApi.listActiveCourses()`
 * (`/lessons/active-courses`, KS-1937). Бэк уже:
 *  - фильтрует по `progress != null && completedAt == null`,
 *  - сортирует по `lastActivityAt` DESC,
 *  - объединяет system + enrolled.
 *
 * До KS-1957 страница делала два параллельных запроса
 * (`listCourses` + `listEnrolled`) и склеивала их клиентом — теперь
 * один запрос, без лишней работы.
 *
 * Каждый item — `<CourseCard>` (CTA = `continue`) + бейдж relative-time
 * через общий `formatRelativeActivity` (`utils/relativeTime`),
 * прокинутый внутрь карточки через `recencyBadge` (KS-1956).
 *
 * Маршрут защищён `<ProtectedRoute>` в App.tsx.
 */

type LoadState = 'loading' | 'ready' | 'error';

interface PageState {
  status: LoadState;
  courses: ActiveCourseSummary[];
}

export function MyActiveCoursesPage() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PageState>({
    status: 'loading',
    courses: [],
  });

  // KS-2099: язык UI пробрасываем в listActiveCourses, чтобы карточки
  // активных курсов соответствовали выбранной локали.
  const lang = i18n.language;
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', courses: [] });

    lessonsApi
      .listActiveCourses(lang)
      .then((list) => {
        if (cancelled) return;
        setState({ status: 'ready', courses: mapActiveCourses(list) });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'error', courses: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [lang]);

  // useMemo фиксирует «сейчас» один раз на готовый стейт — relative-time
  // в карточках считается от одного timestamp, чтобы все «N часов назад»
  // были согласованы.
  const now = useMemo(() => Date.now(), [state.status]);

  return (
    <div
      className="my-active-courses-page"
      data-testid="my-active-courses-page"
      data-state={state.status}
    >
      <nav
        aria-label={t('lessons.myActive.breadcrumbLabel', 'breadcrumb')}
        className="my-active-courses-page__breadcrumb"
        data-testid="my-active-breadcrumb"
      >
        <Link to="/lessons">{t('lessons.title', 'Lessons')}</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">
          {t('lessons.myActive.title', 'My active courses')}
        </span>
      </nav>

      <header className="my-active-courses-page__header">
        <h1>{t('lessons.myActive.title', 'My active courses')}</h1>
        <p className="my-active-courses-page__subtitle">
          {t(
            'lessons.myActive.subtitle',
            'Everything you started — sorted by recent activity.',
          )}
        </p>
      </header>

      {state.status === 'loading' && (
        <ul
          className="my-active-courses-page__list my-active-courses-page__list--skeleton"
          data-testid="my-active-skeleton"
          aria-busy="true"
        >
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="my-active-courses-page__item my-active-courses-page__item--skeleton"
              aria-hidden="true"
            >
              <div className="my-active-courses-page__skeleton-cover" />
              <div className="my-active-courses-page__skeleton-line" />
              <div className="my-active-courses-page__skeleton-line my-active-courses-page__skeleton-line--short" />
            </li>
          ))}
        </ul>
      )}

      {state.status === 'error' && (
        <div
          className="my-active-courses-page__error"
          data-testid="my-active-error"
          role="status"
        >
          {t('lessons.myActive.loadError', 'Failed to load active courses.')}
        </div>
      )}

      {state.status === 'ready' && state.courses.length === 0 && (
        <div
          className="my-active-courses-page__empty"
          data-testid="my-active-empty"
        >
          <p>
            {t(
              'lessons.myActive.empty',
              "You don't have any active courses yet.",
            )}
          </p>
          <Link
            to="/lessons"
            className="my-active-courses-page__empty-cta"
            data-testid="my-active-empty-cta"
          >
            {t('lessons.myActive.emptyCta', 'Browse courses')}
          </Link>
        </div>
      )}

      {state.status === 'ready' && state.courses.length > 0 && (
        <ul
          className="my-active-courses-page__list"
          data-testid="my-active-list"
        >
          {state.courses.map((c) => {
            // KS-1978: inline > i18nKey. Тот же контракт что в Hero.
            const title = resolveInlineText(c.title, c.titleI18nKey, t, c.slug);
            const relative = formatRelativeActivity(
              c.lastActivityAt,
              now,
              t,
              i18n.language || 'en',
            );
            return (
              <li
                key={c.id}
                className="my-active-courses-page__item"
                data-testid={`my-active-item-${c.slug}`}
              >
                <CourseCard
                  testId={`my-active-card-${c.slug}`}
                  slug={c.slug}
                  href={c.href}
                  title={title}
                  level={c.level}
                  coverUrl={c.coverUrl}
                  progress={{ done: c.completedLessons, total: c.lessonCount }}
                  ctaVariant="continue"
                  recencyBadge={relative}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
