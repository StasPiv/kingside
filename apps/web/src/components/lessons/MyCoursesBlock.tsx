import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { userCoursesApi } from '../../api/userCoursesApi';
import { useAuth } from '../../context/AuthContext';

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

      {isLoading && (
        <div className="my-courses-block__loading" data-testid="my-courses-loading">
          {t('common.loading')}
        </div>
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
          {courses.map((c) => (
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
                  <span
                    className={`my-courses-block__badge my-courses-block__badge--${c.isPublic ? 'public' : 'private'}`}
                    data-testid={`my-courses-badge-${c.id}`}
                  >
                    {c.isPublic
                      ? t('lessons.my.publicBadge', 'Public')
                      : t('lessons.my.privateBadge', 'Private')}
                  </span>
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
                </footer>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
