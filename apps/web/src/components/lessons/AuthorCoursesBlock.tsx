import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto, UserCourseListResponse } from '@kingside/shared';

import { api } from '../../api';

/**
 * `AuthorCoursesBlock` — список публичных курсов автора на его
 * странице профиля (KS-1915, BE-endpoint из KS-1914).
 *
 * Контракт endpoint'а:
 *   - `GET /players/:username/courses` — без JWT (публичная страница);
 *   - возвращает `UserCourseListResponse` (`{data: UserCourseDto[]}`),
 *     `stats` отсутствует в JSON — security-параллель из KS-1885;
 *   - 404 при несуществующем username;
 *   - сортировка `updatedAt DESC`, без пагинации (MVP).
 *
 * Видимость:
 *   - блок целиком скрыт пока loading или список пуст —
 *     не плодим лишний UI на профилях без курсов.
 *   - тихо скрывается при ошибке (как `MyCoursesBlock` /
 *     `EnrolledCoursesBlock`) — сетевой сбой не должен прятать
 *     соседние блоки профиля.
 *
 * Карточка переиспользует CSS из `.my-courses-block` (тот же
 * визуальный язык, что у «Мои курсы» / «Курсы, которые я прохожу»).
 */

export interface AuthorCoursesBlockProps {
  username: string;
}

export function AuthorCoursesBlock({ username }: AuthorCoursesBlockProps) {
  const { t } = useTranslation();
  const [courses, setCourses] = useState<UserCourseDto[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setErrored(false);
    api
      .get<UserCourseListResponse>(
        `/players/${encodeURIComponent(username)}/courses`,
      )
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
  }, [username]);

  if (errored) return null;
  if (courses === null || courses.length === 0) return null;

  return (
    <section
      className="my-courses-block"
      data-testid="author-courses-block"
      aria-label={t('playerProfile.coursesTitle', "Author's courses")}
    >
      <header className="my-courses-block__header">
        <h2>{t('playerProfile.coursesTitle', "Author's courses")}</h2>
      </header>

      <ul
        className="my-courses-block__grid"
        data-testid="author-courses-grid"
      >
        {courses.map((c) => (
          <li
            key={c.id}
            className="my-courses-block__card"
            data-testid={`author-courses-card-${c.id}`}
          >
            <Link
              to={`/lessons/my/${c.slug}`}
              className="my-courses-block__link"
              data-testid={`author-courses-link-${c.id}`}
            >
              <header className="my-courses-block__card-header">
                <h3 className="my-courses-block__card-title">{c.title}</h3>
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
    </section>
  );
}
