import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';
import { useAuth } from '../../context/AuthContext';

/**
 * `LatestCoursesBlock` — лента последних публичных курсов на
 * `/lessons` (KS-1919, ADR-030 §2.1).
 *
 * Источник: `GET /lessons/user-courses?mine=0&limit=10`. Backend
 * сортирует `updatedAt DESC`, отдаёт уже без своих курсов
 * (`mine=0`), но мы дополнительно фильтруем по `currentUser.id` на
 * случай гонки кеша / отсутствия JWT при первой подгрузке.
 *
 * Карточка:
 * - Title + бейдж «✦ NEW» если `updatedAt < 7d ago`.
 * - Description (truncate до 100 символов).
 * - lessonCount (i18n plural).
 * - Author username (link на `/players/<username>`) — username
 *   приходит в `UserCourseDto`? Сейчас нет — есть только
 *   `ownerId`. На MVP показываем без username; UI готов принять
 *   его когда backend добавит.
 *
 * Скрыт пока loading / при пустом списке / при ошибке.
 */

const NEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DESCRIPTION_PREVIEW_CHARS = 100;
const FETCH_LIMIT = 10;

type CourseWithUsername = UserCourseDto & {
  ownerUsername?: string;
};

function isNew(updatedAt: string): boolean {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < NEW_THRESHOLD_MS;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function LatestCoursesBlock() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [courses, setCourses] = useState<CourseWithUsername[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErrored(false);
    lessonsApi
      .listLatest({ limit: FETCH_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setCourses((res.data ?? []) as CourseWithUsername[]);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Дополнительный FE-фильтр: backend и так отдаёт `mine=0`, но
  // если в будущем будет гонка кеша или гость → стабильный
  // безопасный фильтр.
  const filtered = useMemo(() => {
    if (!courses) return null;
    if (!user) return courses;
    return courses.filter((c) => c.ownerId !== user.id);
  }, [courses, user]);

  if (errored) return null;
  if (filtered === null || filtered.length === 0) return null;

  return (
    <section
      className="latest-courses-block"
      data-testid="latest-courses-block"
      aria-label={t('lessons.latestCourses.title', 'Latest courses')}
    >
      <header className="latest-courses-block__header">
        <h2>{t('lessons.latestCourses.title', 'Latest courses')}</h2>
      </header>
      <ul
        className="latest-courses-block__grid"
        data-testid="latest-courses-grid"
      >
        {filtered.map((c) => {
          const fresh = isNew(c.updatedAt);
          return (
            <li
              key={c.id}
              className="latest-courses-block__card"
              data-testid={`latest-courses-card-${c.id}`}
            >
              <Link
                to={`/lessons/my/${c.slug}`}
                className="latest-courses-block__link"
              >
                <header className="latest-courses-block__card-header">
                  <h3 className="latest-courses-block__card-title">
                    {c.title}
                  </h3>
                  {fresh && (
                    <span
                      className="latest-courses-block__badge-new"
                      data-testid={`latest-courses-new-${c.id}`}
                    >
                      ✦ {t('lessons.latestCourses.newBadge', 'NEW')}
                    </span>
                  )}
                </header>
                {c.description && (
                  <p className="latest-courses-block__card-description">
                    {truncate(c.description, DESCRIPTION_PREVIEW_CHARS)}
                  </p>
                )}
                <footer className="latest-courses-block__card-footer">
                  <span>
                    {t('lessons.my.lessonsCount', {
                      count: c.lessonCount,
                      defaultValue: '{{count}} lessons',
                    })}
                  </span>
                  {c.ownerUsername && (
                    // Сам Link оборачивает всю карточку, так что
                    // используем `<span>`-роль автора без вложенной
                    // ссылки. Профиль автора достижим через карточку
                    // курса → owner-actions.
                    <span className="latest-courses-block__card-author">
                      {t('lessons.latestCourses.author', {
                        username: c.ownerUsername,
                        defaultValue: 'by {{username}}',
                      })}
                    </span>
                  )}
                </footer>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
