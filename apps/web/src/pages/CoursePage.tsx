import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseWithLessonsResponse } from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { groupLessonsByBlock } from '../components/lessons/courseBlocks';
import { resolveInlineText } from '../utils/inlineI18nText';

/**
 * Страница `/lessons/:courseSlug` — курс с перечнем уроков и прогрессом
 * пользователя (L-07 + KS-1785).
 *
 * Уроки сгруппированы по «блокам» через `groupLessonsByBlock` (см.
 * `components/lessons/courseBlocks.ts`). До появления `blockKey` в
 * API используется slug-fallback для курса beginner.
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
  const blocks = groupLessonsByBlock(sortedLessons);
  const total = sortedLessons.length;
  const completed = progress?.lessonsCompleted ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="course-page" data-testid="course-page">
      <header className="course-header">
        <Link to="/lessons" className="course-back-link" data-testid="course-back-link">
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        <h1>
          {resolveInlineText(course.title, course.titleI18nKey, t, course.slug)}
        </h1>
        <p className="course-description">
          {resolveInlineText(course.description, course.descriptionI18nKey, t, '')}
        </p>
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
        <div className="course-block-list" data-testid="course-lesson-list">
          {blocks.map((block) => (
            <section
              key={block.key}
              className={`course-block course-block--${block.key}`}
              data-testid={`course-block-${block.key}`}
            >
              <h2 className="course-block-title">
                {t(`lessons.block.${block.key}`, block.key)}
              </h2>
              <ol className="course-lesson-list">
                {block.lessons.map((lesson) => {
                  const isMastered = Boolean(lesson.masteredAt);
                  const isDue =
                    Boolean(lesson.dueAt) &&
                    new Date(lesson.dueAt as string).getTime() <= Date.now();
                  return (
                    <li
                      key={lesson.id}
                      className={`course-lesson-item course-lesson-item--${lesson.progressState}`}
                      data-mastered={isMastered ? 'true' : 'false'}
                      data-due={isDue ? 'true' : 'false'}
                    >
                      <Link
                        to={`/lessons/${course.slug}/${lesson.slug}`}
                        data-testid={`lesson-link-${lesson.slug}`}
                        className="course-lesson-link"
                      >
                        {/* KS-1991: индекс убран — был рудимент.
                            Заголовки уроков несут собственную нумерацию
                            («Глава 1. …»), внешний индекс дублировал. */}
                        <span className="course-lesson-title">
                          {resolveInlineText(
                            lesson.title,
                            lesson.titleI18nKey,
                            t,
                            lesson.slug,
                          )}
                        </span>
                        <span
                          className={`course-lesson-state course-lesson-state--${lesson.progressState}`}
                        >
                          {t(
                            `lessons.state.${lesson.progressState}`,
                            lesson.progressState,
                          )}
                        </span>
                        {isMastered && (
                          <span
                            className="course-lesson-badge course-lesson-badge--mastered"
                            data-testid={`course-lesson-mastered-${lesson.slug}`}
                          >
                            {t('lessons.badge.mastered', 'Mastered')}
                          </span>
                        )}
                        {isDue && (
                          <span
                            className="course-lesson-badge course-lesson-badge--due"
                            data-testid={`course-lesson-due-${lesson.slug}`}
                          >
                            {t('lessons.badge.dueForReview', 'Due for review')}
                          </span>
                        )}
                        {/* KS-1992: прогресс по шагам в карточке урока.
                            Если хотя бы 1 шаг сделан — показываем
                            «N/M шагов», иначе общий счётчик «M шагов».
                            `completedStepsCount` приходит с бэка
                            (KS-1992 BE), `0` для анонима/новичка. */}
                        <span
                          className="course-lesson-step-count"
                          data-testid={`course-lesson-step-count-${lesson.slug}`}
                        >
                          {lesson.completedStepsCount > 0
                            ? t('lessons.stepProgress', {
                                done: lesson.completedStepsCount,
                                total: lesson.stepCount,
                                defaultValue: '{{done}}/{{total}} steps',
                              })
                            : t('lessons.stepCount', {
                                count: lesson.stepCount,
                                defaultValue: '{{count}} steps',
                              })}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
