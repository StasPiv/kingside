import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { formatRelativeActivity } from '../utils/relativeTime';

/**
 * `MyCoursesPage` — страница `/lessons/my` (ADR-052 §3.3, Tier 1 #1,
 * KS-2620).
 *
 * Полный список собственных курсов автора: Public/Private бейдж, title,
 * meta «N lessons · updated <relative>», stats для владельца
 * (`enrolled / completed (%)`), опциональное описание (truncate 2 lines).
 *
 * Источник — `userCoursesApi.list({ scope: 'own' })`. Используется тот
 * же endpoint и стилевой каркас, что и компактный `MyCoursesBlock`
 * на /lessons (KS-1840), — переиспользуем `.my-courses-block__*`
 * классы для карточек и пустого состояния, чтобы визуал был идентичен.
 *
 * Маршрут под `<ProtectedRoute>` (см. App.tsx) — гость на странице не
 * рендерится. Действия Open/Edit/Copy/visibility/delete по карточке —
 * отдельная задача (ADR-052 #2).
 */
export function MyCoursesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [courses, setCourses] = useState<UserCourseDto[] | null>(null);
  const [errored, setErrored] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setErrored(false);
    setCourses(null);
    userCoursesApi
      .list({ scope: 'own' })
      .then((res) => {
        if (cancelled) return;
        setCourses(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const created = await userCoursesApi.create({
        title: t('lessons.my.editor.defaultCourseTitle', 'New course'),
      });
      navigate(`/lessons/my/${created.slug}/edit`);
    } catch {
      setCreateError(
        t('lessons.my.createModal.error', 'Failed to create the course'),
      );
    } finally {
      setCreating(false);
    }
  };

  const isLoading = courses === null && !errored;
  const isEmpty = courses !== null && courses.length === 0;
  // Анти-flicker (KS-1924): skeleton показываем только если загрузка
  // длится >200мс — иначе пользователь видит «вспышку».
  const showSkeleton = useDelayedFlag(isLoading, 200);
  // Один общий «сейчас» на рендер — все «обновлено N часов назад» в
  // карточках считаются от одного timestamp, чтобы строки были
  // согласованы между собой. Пересчитываем при каждой смене длины
  // списка (после перезагрузки), а не при каждом ре-рендере, иначе
  // карточки бы пересоздавали relative-string без причины.
  const coursesLen = courses?.length ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [coursesLen]);

  return (
    <div
      className="my-courses-page"
      data-testid="my-courses-page"
      data-state={
        isLoading ? 'loading' : errored ? 'error' : isEmpty ? 'empty' : 'ready'
      }
    >
      <nav
        aria-label={t('lessons.my.breadcrumbLabel', 'breadcrumb')}
        className="my-courses-page__breadcrumb"
        data-testid="my-courses-breadcrumb"
      >
        <Link to="/lessons">{t('lessons.title', 'Lessons')}</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">
          {t('lessons.my.pageTitle', 'My courses')}
        </span>
      </nav>

      <header className="my-courses-page__header">
        <div className="my-courses-page__title-block">
          <h1>{t('lessons.my.pageTitle', 'My courses')}</h1>
          <p className="my-courses-page__subtitle">
            {t(
              'lessons.my.subtitle',
              'All courses you authored — public and private.',
            )}
          </p>
        </div>
        <button
          type="button"
          className="my-courses-block__create"
          onClick={handleCreate}
          disabled={creating}
          data-testid="my-courses-create"
        >
          {creating
            ? t('lessons.my.createModal.submitting', 'Creating…')
            : t('lessons.my.create', '+ Create my course')}
        </button>
      </header>

      {createError && (
        <p
          className="my-courses-block__error"
          data-testid="my-courses-create-error"
          role="status"
        >
          {createError}
        </p>
      )}

      {errored && (
        <div
          className="my-courses-block__error"
          data-testid="my-courses-load-error"
          role="status"
        >
          {t('lessons.my.loadError', 'Failed to load your courses.')}
        </div>
      )}

      {isLoading && showSkeleton && (
        <ul
          className="my-courses-block__grid my-courses-block__grid--skeleton"
          data-testid="my-courses-skeleton"
          aria-busy="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li
              key={i}
              className="my-courses-block__card my-courses-block__card--skeleton"
              aria-hidden="true"
            >
              <div className="my-courses-block__skeleton-title" />
              <div className="my-courses-block__skeleton-line" />
              <div className="my-courses-block__skeleton-line my-courses-block__skeleton-line--short" />
            </li>
          ))}
        </ul>
      )}

      {isEmpty && (
        <div
          className="my-courses-block__empty"
          data-testid="my-courses-empty"
        >
          <p>
            {t(
              'lessons.my.emptyHeading',
              "You haven't created any courses yet.",
            )}
          </p>
          <button
            type="button"
            className="my-courses-block__create"
            onClick={handleCreate}
            disabled={creating}
            data-testid="my-courses-empty-cta"
          >
            {creating
              ? t('lessons.my.createModal.submitting', 'Creating…')
              : t('lessons.my.empty.cta', '+ Create your first course')}
          </button>
        </div>
      )}

      {!isLoading && !isEmpty && courses && courses.length > 0 && (
        <ul
          className="my-courses-block__grid"
          data-testid="my-courses-grid"
        >
          {courses.map((c) => {
            const relative = formatRelativeActivity(
              c.updatedAt,
              now,
              t,
              i18n.language || 'en',
            );
            const stats = c.stats;
            const percent =
              stats && stats.enrolledCount > 0
                ? Math.round((stats.completedCount / stats.enrolledCount) * 100)
                : null;
            return (
              <li
                key={c.id}
                className="my-courses-block__card"
                data-testid={`my-courses-card-${c.id}`}
              >
                <Link
                  to={`/lessons/my/${c.slug}`}
                  className="my-courses-block__link"
                >
                  <header className="my-courses-block__card-header">
                    <h3 className="my-courses-block__card-title">{c.title}</h3>
                    <div className="my-courses-block__card-badges">
                      <span
                        className={`my-courses-block__badge my-courses-block__badge--${c.isPublic ? 'public' : 'private'}`}
                        data-testid={`my-courses-badge-${c.id}`}
                      >
                        {c.isPublic
                          ? t('lessons.my.publicBadge', 'Public')
                          : t('lessons.my.privateBadge', 'Private')}
                      </span>
                    </div>
                  </header>
                  {c.description && (
                    <p
                      className="my-courses-block__card-description my-courses-page__card-description--clamp"
                      data-testid={`my-courses-desc-${c.id}`}
                    >
                      {c.description}
                    </p>
                  )}
                  <footer className="my-courses-block__card-footer">
                    <span data-testid={`my-courses-meta-${c.id}`}>
                      {t('lessons.my.lessonsCount', {
                        count: c.lessonCount,
                        defaultValue: '{{count}} lessons',
                      })}
                      {' · '}
                      {t('lessons.my.updatedRelative', {
                        relative,
                        defaultValue: 'updated {{relative}}',
                      })}
                    </span>
                    {stats && (
                      <span
                        className="my-courses-block__card-stats"
                        data-testid={`my-courses-stats-${c.id}`}
                      >
                        {percent !== null
                          ? t('lessons.my.stats.percent', {
                              enrolled: stats.enrolledCount,
                              completed: stats.completedCount,
                              percent,
                              defaultValue:
                                '{{enrolled}} enrolled · {{completed}} completed ({{percent}}%)',
                            })
                          : t('lessons.my.stats.compact', {
                              enrolled: stats.enrolledCount,
                              completed: stats.completedCount,
                              defaultValue:
                                '{{enrolled}} enrolled · {{completed}} completed',
                            })}
                      </span>
                    )}
                  </footer>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
