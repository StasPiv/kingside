import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserEnrolledCourseDto } from '@kingside/shared';

import { userCoursesApi } from '../../api/userCoursesApi';
import { useAuth } from '../../context/AuthContext';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';

/**
 * `EnrolledCoursesBlock` — блок «Курсы, которые я прохожу» на странице
 * `/lessons` (KS-1890). Дополняет `MyCoursesBlock` (свои собственные
 * курсы) — здесь курсы других авторов, в которых юзер уже сделал
 * хоть один шаг или прошёл их.
 *
 * Backend (KS-1889) отдаёт `GET /lessons/user-courses/enrolled` с
 * `progress` в каждой записи без N+1, поэтому компонент не делает
 * отдельных запросов на прогресс по каждой карточке (как в
 * `MyCoursesBlock`, где list-DTO без прогресса).
 *
 * Видимость:
 *   - только залогиненным пользователям (как и `MyCoursesBlock`);
 *   - блок целиком скрывается при пустом списке — не плодим лишний
 *     UI, если у юзера нет enrolled-курсов.
 *
 * Карточка:
 *   - title + бейдж «✓ Пройден» (тот же стиль что в `MyCoursesBlock`,
 *     KS-1882) при `progress.completedAt != null`;
 *   - кратко прогресс «N/M уроков» (locale plural из KS-1884);
 *   - ссылка на `/lessons/my/:slug`.
 *
 * CTA «Создать» НЕТ — это не свои курсы.
 *
 * # Каталог публичных курсов
 *
 * Этот блок имеет смысл только когда есть способ обнаружить чужой
 * публичный курс (каталог). Координатор завёл отдельную задачу на
 * каталог — эта задача готовит UI к моменту, когда такой каталог
 * появится.
 */

export function EnrolledCoursesBlock() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [courses, setCourses] = useState<UserEnrolledCourseDto[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setErrored(false);
    userCoursesApi
      .listEnrolled()
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

  // KS-1924: анти-flicker. Skeleton показываем только при долгой
  // загрузке (>200мс). Если данные пришли быстро — никакой вспышки.
  const isLoading = courses === null;
  const showSkeleton = useDelayedFlag(isLoading && !!user, 200);

  // Гости не видят блок.
  if (!user) return null;

  // Тихо: ошибка не должна прятать соседние блоки на /lessons.
  if (errored) return null;

  // Skeleton-state (только если ждём долго): три карточки-плейсхолдера.
  if (isLoading) {
    if (!showSkeleton) return null;
    return (
      <section
        className="my-courses-block my-courses-block--skeleton"
        data-testid="enrolled-courses-skeleton"
        aria-busy="true"
        aria-label={t('lessons.enrolled.title', "Courses I'm taking")}
      >
        <header className="my-courses-block__header">
          <div className="my-courses-block__skeleton-heading" />
        </header>
        <ul
          className="my-courses-block__grid my-courses-block__grid--skeleton"
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
      </section>
    );
  }

  // Пустой список — блок не нужен (DoD).
  if (courses.length === 0) return null;

  return (
    <section
      className="my-courses-block"
      data-testid="enrolled-courses-block"
      aria-label={t('lessons.enrolled.title', "Courses I'm taking")}
    >
      <header className="my-courses-block__header">
        <h2>{t('lessons.enrolled.title', "Courses I'm taking")}</h2>
      </header>

      <ul
        className="my-courses-block__grid"
        data-testid="enrolled-courses-grid"
      >
        {courses.map((c) => {
          const isCompleted = Boolean(c.progress?.completedAt);
          const done = c.progress?.completedLessonsCount ?? 0;
          return (
            <li
              key={c.id}
              className={`my-courses-block__card${isCompleted ? ' my-courses-block__card--completed' : ''}`}
              data-testid={`enrolled-courses-card-${c.id}`}
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
                        data-testid={`enrolled-courses-completed-${c.id}`}
                        title={t('lessons.completed.banner', 'Course completed')}
                      >
                        ✓ {t('lessons.completed.shortBadge', 'Done')}
                      </span>
                    )}
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
                  <span
                    className="my-courses-block__card-stats"
                    data-testid={`enrolled-courses-progress-${c.id}`}
                  >
                    {t('lessons.my.progress', {
                      count: c.lessonCount,
                      done,
                      defaultValue: 'Completed {{done}}/{{count}} lessons',
                    })}
                  </span>
                </footer>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
