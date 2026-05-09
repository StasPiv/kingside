import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseAuthorDto } from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';

/**
 * `CourseAuthorsBlock` — топ-12 авторов курсов на `/lessons`
 * (KS-1919, ADR-030 §2.2).
 *
 * Источник: `GET /lessons/user-courses/authors?limit=12&sort=courses`
 * (без JWT, кеш 5 мин). Сортировка `courses` по умолчанию даёт
 * `publicCoursesCount DESC, lastCourseUpdatedAt DESC`.
 *
 * Карточка автора:
 * - Avatar (если `avatarUrl` пришёл от backend; иначе круглый
 *   плейсхолдер с первой буквой username).
 * - Username с link на `/player/<username>`.
 * - N courses (i18n plural).
 * - Teaser «Last: <latestCourseTitle>» с link на
 *   `/lessons/my/<latestCourseSlug>`.
 *
 * Внизу блока кнопка «All authors» → `/players?tab=authors`
 * (полный список с infinite scroll, KS-1920).
 *
 * Скрыт пока loading / при пустом списке / при ошибке.
 */

const FETCH_LIMIT = 12;

export function CourseAuthorsBlock() {
  const { t } = useTranslation();
  const [authors, setAuthors] = useState<CourseAuthorDto[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErrored(false);
    lessonsApi
      .listAuthors({ sort: 'courses', limit: FETCH_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setAuthors(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (errored) return null;
  if (authors === null || authors.length === 0) return null;

  return (
    <section
      className="course-authors-block"
      data-testid="course-authors-block"
      aria-label={t('lessons.courseAuthors.title', 'Course authors')}
    >
      <header className="course-authors-block__header">
        <h2>{t('lessons.courseAuthors.title', 'Course authors')}</h2>
      </header>
      <ul
        className="course-authors-block__grid"
        data-testid="course-authors-grid"
      >
        {authors.map((a) => (
          <li
            key={a.user.id}
            className="course-authors-block__card"
            data-testid={`course-authors-card-${a.user.id}`}
          >
            <div className="course-authors-block__card-main">
              <div
                className="course-authors-block__avatar"
                aria-hidden="true"
              >
                {a.user.avatarUrl ? (
                  <img src={a.user.avatarUrl} alt="" loading="lazy" />
                ) : (
                  <span className="course-authors-block__avatar-fallback">
                    {a.user.username.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="course-authors-block__info">
                <Link
                  to={`/player/${encodeURIComponent(a.user.username)}`}
                  className="course-authors-block__username"
                  data-testid={`course-authors-link-${a.user.id}`}
                >
                  {a.user.displayName || a.user.username}
                </Link>
                <span className="course-authors-block__count">
                  {t('lessons.courseAuthors.coursesCount', {
                    count: a.publicCoursesCount,
                    defaultValue: '{{count}} courses',
                  })}
                </span>
              </div>
            </div>
            <Link
              to={`/lessons/my/${a.latestCourseSlug}`}
              className="course-authors-block__teaser"
              data-testid={`course-authors-teaser-${a.user.id}`}
              title={a.latestCourseTitle}
            >
              {t('lessons.courseAuthors.latest', {
                title: a.latestCourseTitle,
                defaultValue: 'Last: {{title}}',
              })}
            </Link>
          </li>
        ))}
      </ul>
      <footer className="course-authors-block__footer">
        <Link
          to="/players?tab=authors"
          className="course-authors-block__all-link"
          data-testid="course-authors-all-link"
        >
          {t('lessons.courseAuthors.allAuthors', 'All authors')}
        </Link>
      </footer>
    </section>
  );
}
