import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';
import { useAuth } from '../../context/AuthContext';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';

/**
 * `CommunityStripBlock` — компактная горизонтальная полоса
 * последних публичных курсов на `/lessons` (KS-1923, ADR-031 §3).
 *
 * Отличается от полного `LatestCoursesBlock` (который теперь живёт
 * на `/lessons/discover`):
 * - **меньше** карточек (5 вместо 10);
 * - заголовок «Новое от сообщества» + кнопка-ссылка
 *   «Все курсы и авторы →» ведёт на `/lessons/discover`;
 * - на mobile — `overflow-x: auto` (горизонтальный scroll), на
 *   desktop — обычный grid;
 * - бейдж «✦ NEW» при `updatedAt < 7d`.
 *
 * Скрыт пока loading / при пустом списке (после фильтра своих) /
 * при ошибке.
 */

const STRIP_LIMIT = 5;
const NEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function isNew(updatedAt: string): boolean {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < NEW_THRESHOLD_MS;
}

export function CommunityStripBlock() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [courses, setCourses] = useState<UserCourseDto[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErrored(false);
    lessonsApi
      .listLatest({ limit: STRIP_LIMIT })
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
  }, []);

  const filtered = useMemo(() => {
    if (!courses) return null;
    if (!user) return courses;
    return courses.filter((c) => c.ownerId !== user.id);
  }, [courses, user]);

  // KS-1924: анти-flicker. Skeleton-полоса видна только если данные
  // грузятся дольше 200мс — на быстром API сразу пропускаем.
  const isLoading = filtered === null;
  const showSkeleton = useDelayedFlag(isLoading, 200);

  if (errored) return null;

  if (isLoading) {
    if (!showSkeleton) return null;
    return (
      <section
        className="community-strip-block community-strip-block--skeleton"
        data-testid="community-strip-skeleton"
        aria-busy="true"
        aria-label={t('lessons.community.title', 'New from community')}
      >
        <header className="community-strip-block__header">
          <div className="community-strip-block__skeleton-heading" />
        </header>
        <ul
          className="community-strip-block__list community-strip-block__list--skeleton"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <li
              key={i}
              className="community-strip-block__card community-strip-block__card--skeleton"
              aria-hidden="true"
            >
              <div className="community-strip-block__skeleton-title" />
              <div className="community-strip-block__skeleton-line" />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (filtered.length === 0) return null;

  return (
    <section
      className="community-strip-block"
      data-testid="community-strip-block"
      aria-label={t('lessons.community.title', 'New from community')}
    >
      <header className="community-strip-block__header">
        <h2>{t('lessons.community.title', 'New from community')}</h2>
        <Link
          to="/lessons/discover"
          className="community-strip-block__view-all"
          data-testid="community-strip-view-all"
        >
          {t('lessons.community.viewAll', 'All courses & authors →')}
        </Link>
      </header>

      <ul
        className="community-strip-block__list"
        data-testid="community-strip-list"
      >
        {filtered.map((c) => (
          <li
            key={c.id}
            className="community-strip-block__card"
            data-testid={`community-strip-card-${c.id}`}
          >
            <Link
              to={`/lessons/my/${c.slug}`}
              className="community-strip-block__link"
            >
              <header className="community-strip-block__card-header">
                <h3 className="community-strip-block__card-title">{c.title}</h3>
                {isNew(c.updatedAt) && (
                  <span
                    className="community-strip-block__badge-new"
                    data-testid={`community-strip-new-${c.id}`}
                  >
                    ✦ {t('lessons.latestCourses.newBadge', 'NEW')}
                  </span>
                )}
              </header>
              <footer className="community-strip-block__card-footer">
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
