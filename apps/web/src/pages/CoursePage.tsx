import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseWithLessonsResponse } from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';

/**
 * Страница `/lessons/:courseSlug` — курс с перечнем уроков и прогрессом
 * пользователя (L-07).
 *
 * MVP: уроки идут плоским списком, отсортированным по `order`. Группировка
 * в «блоки» (`Block`) появится позже (L-08+) — типы для блоков пока в
 * shared не вынесены, поэтому здесь обходимся плоским списком.
 */

export function CoursePage() {
  const { t } = useTranslation();
  const { courseSlug } = useParams<{ courseSlug: string }>();

  const [data, setData] = useState<CourseWithLessonsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!courseSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    lessonsApi
      .getCourse(courseSlug)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('lessons.loadError', 'Failed to load course'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseSlug, t]);

  if (!courseSlug) {
    return (
      <div className="error" data-testid="course-error">
        {t('lessons.invalidCourse', 'Invalid course slug')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="loading" data-testid="course-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error" data-testid="course-error">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="lessons-empty" data-testid="course-empty">
        {t('lessons.courseNotFound', 'Course not found')}
      </div>
    );
  }

  const { course, lessons, progress } = data;
  const sortedLessons = [...lessons].sort((a, b) => a.order - b.order);
  const total = sortedLessons.length;
  const completed = progress?.lessonsCompleted ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="course-page" data-testid="course-page">
      <header className="course-header">
        <Link to="/lessons" className="course-back-link" data-testid="course-back-link">
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        <h1>{t(course.titleI18nKey, course.slug)}</h1>
        <p className="course-description">{t(course.descriptionI18nKey, '')}</p>
        <div
          className="course-progress"
          data-testid="course-progress"
          aria-label={t('lessons.progressLabel', 'Course progress')}
        >
          <div className="course-progress-bar">
            <div
              className="course-progress-fill"
              style={{ width: `${percent}%` }}
              data-testid="course-progress-fill"
            />
          </div>
          <span className="course-progress-text">
            {t('lessons.progressFull', {
              completed,
              total,
              percent,
              defaultValue: '{{completed}}/{{total}} ({{percent}}%)',
            })}
          </span>
        </div>
      </header>

      {sortedLessons.length === 0 ? (
        <div className="lessons-empty" data-testid="course-no-lessons">
          {t('lessons.noLessons', 'No lessons in this course yet')}
        </div>
      ) : (
        <ol className="course-lesson-list" data-testid="course-lesson-list">
          {sortedLessons.map((lesson) => (
            <li
              key={lesson.id}
              className={`course-lesson-item course-lesson-item--${lesson.progressState}`}
            >
              <Link
                to={`/lessons/${course.slug}/${lesson.slug}`}
                data-testid={`lesson-link-${lesson.slug}`}
                className="course-lesson-link"
              >
                <span className="course-lesson-order">{lesson.order}.</span>
                <span className="course-lesson-title">
                  {t(lesson.titleI18nKey, lesson.slug)}
                </span>
                <span className={`course-lesson-state course-lesson-state--${lesson.progressState}`}>
                  {t(`lessons.state.${lesson.progressState}`, lesson.progressState)}
                </span>
                <span className="course-lesson-step-count">
                  {t('lessons.stepCount', {
                    count: lesson.stepCount,
                    defaultValue: '{{count}} steps',
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
