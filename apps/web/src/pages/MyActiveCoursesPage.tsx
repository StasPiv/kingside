import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseListItem,
  UserEnrolledCourseDto,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { userCoursesApi } from '../api/userCoursesApi';
import { CourseCard } from '../components/lessons/CourseCard';
import type { ActiveCourseSummary } from '../hooks/useLessonsHeroContext';
import { formatRelativeActivity } from '../utils/relativeTime';

/**
 * `MyActiveCoursesPage` — страница `/lessons/my-active`
 * (KS-1941 / F-4 / KS-1931 §3.2 §7.3).
 *
 * Показывает все активные курсы пользователя одним списком M-карточек:
 *  - системные курсы с `progress != null && completedAt == null`,
 *  - enrolled-пользовательские с теми же критериями.
 *
 * Sort — `lastActivityAt DESC` (свежее активность сверху). На каждую
 * карточку — бейдж «N дней назад» через
 * `utils/relativeTime.formatRelativeActivity` (тот же helper, что в
 * Hero Variant B).
 *
 * Источник данных — пока агрегация двух эндпоинтов (`listCourses`,
 * `listEnrolled`) на стороне фронта. Это дублирует то, что делает
 * `useLessonsHeroContext`, но оба места хотят независимости (в Hero —
 * выбираем 1 курс, тут — все). Единый эндпоинт `/lessons/my-active`
 * запланирован в B-5 (KS-1937), на этот момент перепишем хук + страницу
 * на него.
 *
 * `own` (UserCourseDto) НЕ учитываются — у DTO нет `progress`. См.
 * KS-1938 §3.3 концепта (custom-собственные показываются как
 * активные, только если автор сам в них enroll'нулся, а это уже
 * `listEnrolled`).
 *
 * Маршрут защищён `<ProtectedRoute>` в App.tsx (компонент сам не
 * редиректит — это слой выше).
 */

type LoadState = 'loading' | 'ready' | 'error';

interface PageState {
  status: LoadState;
  courses: ActiveCourseSummary[];
}

function mapSystemActive(c: CourseListItem): ActiveCourseSummary | null {
  if (!c.progress || c.progress.completedAt !== null) return null;
  return {
    source: 'system',
    id: c.id,
    slug: c.slug,
    title: '',
    titleI18nKey: c.titleI18nKey,
    level: c.level,
    coverUrl: c.coverUrl ?? null,
    lessonCount: c.lessonCount,
    completedLessons: c.progress.lessonsCompleted,
    lastActivityAt: c.progress.lastActivityAt ?? c.progress.startedAt,
    currentLessonSlug: c.progress.currentLessonSlug ?? null,
    currentLessonTitleI18nKey: c.progress.currentLessonTitleI18nKey ?? null,
    currentLessonTitle: null,
    currentLessonOrder: c.progress.currentLessonOrder ?? null,
    href: `/lessons/${c.slug}`,
  };
}

function mapEnrolledActive(
  c: UserEnrolledCourseDto,
): ActiveCourseSummary | null {
  if (c.progress.completedAt !== null) return null;
  return {
    source: 'enrolled',
    id: c.id,
    slug: c.slug,
    title: c.title,
    titleI18nKey: null,
    level: null,
    coverUrl: c.coverUrl ?? null,
    lessonCount: c.lessonCount,
    completedLessons: c.progress.completedLessonsCount,
    lastActivityAt: c.progress.lastActivityAt,
    currentLessonSlug: c.progress.currentLessonSlug ?? null,
    currentLessonTitleI18nKey: null,
    currentLessonTitle: c.progress.currentLessonTitle ?? null,
    currentLessonOrder: c.progress.currentLessonOrder ?? null,
    href: `/lessons/my/${c.slug}`,
  };
}

export function MyActiveCoursesPage() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PageState>({
    status: 'loading',
    courses: [],
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', courses: [] });

    Promise.allSettled([
      lessonsApi.listCourses(),
      userCoursesApi.listEnrolled(),
    ]).then((results) => {
      if (cancelled) return;
      const [systemRes, enrolledRes] = results;

      // Если ОБА запроса упали — это ошибка страницы. Если упал один,
      // показываем что есть (graceful degradation).
      if (systemRes.status === 'rejected' && enrolledRes.status === 'rejected') {
        setState({ status: 'error', courses: [] });
        return;
      }

      const system =
        systemRes.status === 'fulfilled' ? (systemRes.value.data ?? []) : [];
      const enrolled =
        enrolledRes.status === 'fulfilled'
          ? (enrolledRes.value.data ?? [])
          : [];

      const activeSystem = system
        .map(mapSystemActive)
        .filter((c): c is ActiveCourseSummary => c !== null);
      const activeEnrolled = enrolled
        .map(mapEnrolledActive)
        .filter((c): c is ActiveCourseSummary => c !== null);

      const all = [...activeSystem, ...activeEnrolled].sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );

      setState({ status: 'ready', courses: all });
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
            const title = c.titleI18nKey
              ? t(c.titleI18nKey, c.slug)
              : c.title || c.slug;
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
                />
                <span
                  className="my-active-courses-page__last-activity"
                  data-testid={`my-active-relative-${c.slug}`}
                >
                  {relative}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
