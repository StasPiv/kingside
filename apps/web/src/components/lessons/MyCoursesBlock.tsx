import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserCourseDto,
  UserCoursePlayProgressDto,
} from '@kingside/shared';

import { userCoursesApi } from '../../api/userCoursesApi';
import { useAuth } from '../../context/AuthContext';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';

/**
 * `MyCoursesBlock` — блок «Мои курсы» на странице `/lessons`
 * (ADR-026 §2.6, KS-1840 / FE-6).
 *
 * Видимость: только залогиненным пользователям. Гостям блок не
 * рендерится — создавать курсы можно только после логина, а чужие
 * блоки показывать без повода смысла нет.
 *
 * Загружает свои курсы через `userCoursesApi.list({ scope: 'own' })`.
 * При ошибке тихо выходит (блок просто не появляется — системные курсы
 * не должны падать из-за нашего сбоя). Пустое состояние — CTA вида
 * «+ Создать свой курс».
 *
 * При клике на CTA создаётся новый черновик через POST, затем происходит
 * навигация в `/lessons/my/:slug/edit`.
 */

export function MyCoursesBlock() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [courses, setCourses] = useState<UserCourseDto[] | null>(null);
  const [progressByCourseId, setProgressByCourseId] = useState<
    Record<string, UserCoursePlayProgressDto | null>
  >({});
  const [errored, setErrored] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setErrored(false);
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

  // KS-1882: для completion-индикатора нужен `progress.completedAt`
  // каждого курса. List-DTO его не содержит, поэтому подтягиваем
  // прогресс параллельно по `getCourseProgress` отдельным эффектом
  // (после получения списка). Если запрос провалится или вернёт null
  // — карточка просто без иконки. Нагрузка в худшем случае — N
  // запросов на N курсов пользователя; для типичного 5–10 курсов
  // это незаметно.
  useEffect(() => {
    if (!courses || courses.length === 0) return;
    let cancelled = false;
    Promise.all(
      courses.map((c) =>
        userCoursesApi
          .getCourseProgress(c.id)
          .then((p) => [c.id, p] as const)
          .catch(() => [c.id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, UserCoursePlayProgressDto | null> = {};
      for (const [id, p] of entries) next[id] = p;
      setProgressByCourseId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [courses]);

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const created = await userCoursesApi.create({
        title: t(
          'lessons.my.editor.defaultCourseTitle',
          'New course',
        ),
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

  // Гости не видят блок: без user нет смысла показывать «мои курсы» и CTA.
  if (!user) return null;

  // Тихо: ошибка загрузки своих курсов не должна прятать системные курсы
  // под блоком «Error» — компонент просто не показывается.
  if (errored) return null;

  const isEmpty = courses !== null && courses.length === 0;
  const isLoading = courses === null;
  // KS-1924: анти-flicker. Skeleton рисуем только если загрузка
  // длится >200мс — иначе пользователь увидит «вспышку» перед
  // настоящим контентом.
  const showSkeleton = useDelayedFlag(isLoading, 200);

  return (
    <section
      className="my-courses-block"
      data-testid="my-courses-block"
      aria-label={t('lessons.my.title', 'My courses')}
    >
      <header className="my-courses-block__header">
        <h2>{t('lessons.my.title', 'My courses')}</h2>
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

      {isLoading && showSkeleton && (
        <ul
          className="my-courses-block__grid my-courses-block__grid--skeleton"
          data-testid="my-courses-skeleton"
          aria-busy="true"
        >
          {[0, 1, 2].map((i) => (
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
        <p
          className="my-courses-block__empty"
          data-testid="my-courses-empty"
        >
          {t('lessons.my.empty', "You haven't created any courses yet")}
        </p>
      )}

      {!isLoading && !isEmpty && courses && (
        <ul
          className="my-courses-block__grid"
          data-testid="my-courses-grid"
        >
          {courses.map((c) => {
            const courseProgress = progressByCourseId[c.id];
            const isCompleted = Boolean(courseProgress?.completedAt);
            return (
              <li
                key={c.id}
                className={`my-courses-block__card${isCompleted ? ' my-courses-block__card--completed' : ''}`}
                data-testid={`my-courses-card-${c.id}`}
              >
                <Link
                  to={`/lessons/my/${c.slug}`}
                  className="my-courses-block__link"
                >
                  <header className="my-courses-block__card-header">
                    <h3 className="my-courses-block__card-title">{c.title}</h3>
                    <div className="my-courses-block__card-badges">
                      {isCompleted && (
                        <span
                          className="my-courses-block__badge my-courses-block__badge--completed"
                          data-testid={`my-courses-completed-${c.id}`}
                          title={t('lessons.completed.banner', 'Course completed')}
                        >
                          ✓ {t('lessons.completed.shortBadge', 'Done')}
                        </span>
                      )}
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
                    <p className="my-courses-block__card-description">
                      {c.description}
                    </p>
                  )}
                  <footer className="my-courses-block__card-footer">
                    <span>
                      {t('lessons.my.lessonsCount', {
                        count: c.lessonCount,
                        defaultValue: '{{count}} lessons',
                      })}
                    </span>
                    {/* KS-1886: компактный счётчик прохождений —
                        BE отдаёт `stats` только владельцу. */}
                    {c.stats && (
                      <span
                        className="my-courses-block__card-stats"
                        data-testid={`my-courses-stats-${c.id}`}
                      >
                        {t('lessons.my.stats.compact', {
                          enrolled: c.stats.enrolledCount,
                          completed: c.stats.completedCount,
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
    </section>
  );
}
