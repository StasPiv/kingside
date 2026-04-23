import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseWithLessonsResponse,
  LessonWithStepsResponse,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { StepRenderer } from '../components/lessons/StepRenderer';
import { useLessonProgress } from '../hooks/useLessonProgress';

/**
 * Страница `/lessons/:courseSlug/:lessonSlug` — контейнер для шагов урока (L-07).
 *
 * - резолв slug → id урока через `getCourse(courseSlug)`
 * - загрузка `getLesson(lessonId)`
 * - рендер шагов через `StepRenderer` (L-08)
 * - прогресс через `useLessonProgress` (L-11): индикатор + дебаунс-апдейты
 *   шагов в API + кнопка «Завершить урок» с порогом ≥70%.
 */

export function LessonPage() {
  const { t } = useTranslation();
  const { courseSlug, lessonSlug } = useParams<{
    courseSlug: string;
    lessonSlug: string;
  }>();

  const [course, setCourse] = useState<CourseWithLessonsResponse | null>(null);
  const [lesson, setLesson] = useState<LessonWithStepsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!courseSlug || !lessonSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLesson(null);
    setCompleteMessage(null);

    lessonsApi
      .getCourse(courseSlug)
      .then(async (courseRes) => {
        if (cancelled) return;
        setCourse(courseRes);
        const summary = courseRes.lessons.find((l) => l.slug === lessonSlug);
        if (!summary) {
          throw new Error('lesson_not_found');
        }
        const lessonRes = await lessonsApi.getLesson(summary.id);
        if (cancelled) return;
        setLesson(lessonRes);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err?.message === 'lesson_not_found') {
          setError(t('lessons.lessonNotFound', 'Lesson not found'));
        } else {
          setError(t('lessons.loadError', 'Failed to load lesson'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseSlug, lessonSlug, t]);

  const sortedSteps = useMemo(
    () => (lesson ? [...lesson.steps].sort((a, b) => a.order - b.order) : []),
    [lesson],
  );

  const progress = useLessonProgress({
    lessonId: lesson?.lesson.id ?? null,
    totalSteps: sortedSteps.length,
    initialProgress: lesson?.progress ?? null,
  });

  if (!courseSlug || !lessonSlug) {
    return (
      <div className="error" data-testid="lesson-error">
        {t('lessons.invalidLesson', 'Invalid lesson URL')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="loading" data-testid="lesson-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error" data-testid="lesson-error">
        {error}
      </div>
    );
  }

  if (!lesson) {
    return (
      <div className="lessons-empty" data-testid="lesson-empty">
        {t('lessons.lessonNotFound', 'Lesson not found')}
      </div>
    );
  }

  const handleComplete = async () => {
    setCompleteMessage(null);
    const outcome = await progress.completeLesson();
    if (outcome.ok) {
      setCompleteMessage(
        t('lessons.completeSuccess', 'Lesson completed!'),
      );
    } else if (outcome.error) {
      setCompleteMessage(
        t('lessons.completeError', 'Failed to mark lesson as completed'),
      );
    } else {
      setCompleteMessage(
        t('lessons.completeBelowThreshold', {
          percent: Math.round(outcome.threshold * 100),
          defaultValue: 'Need ≥ {{percent}}% steps done to complete this lesson',
        }),
      );
    }
  };

  const percent = Math.round(progress.score * 100);
  const canComplete = progress.score >= progress.threshold;

  return (
    <div className="lesson-page" data-testid="lesson-page">
      <header className="lesson-header">
        {course && (
          <Link
            to={`/lessons/${course.course.slug}`}
            className="lesson-back-link"
            data-testid="lesson-back-link"
          >
            ← {t(course.course.titleI18nKey, course.course.slug)}
          </Link>
        )}
        <h1>{t(lesson.lesson.titleI18nKey, lesson.lesson.slug)}</h1>
        <p className="lesson-summary">
          {t(lesson.lesson.summaryI18nKey, '')}
        </p>

        <div
          className="lesson-progress"
          data-testid="lesson-progress"
          aria-label={t('lessons.progressLabel', 'Course progress')}
        >
          <div className="lesson-progress-bar">
            <div
              className="lesson-progress-fill"
              style={{ width: `${percent}%` }}
              data-testid="lesson-progress-fill"
            />
          </div>
          <span className="lesson-progress-text" data-testid="lesson-progress-text">
            {t('lessons.lessonProgress', {
              done: progress.doneCount,
              total: progress.totalSteps,
              percent,
              defaultValue: '{{done}}/{{total}} steps ({{percent}}%)',
            })}
          </span>
        </div>
      </header>

      {sortedSteps.length === 0 ? (
        <div className="lessons-empty" data-testid="lesson-no-steps">
          {t('lessons.noSteps', 'No steps in this lesson yet')}
        </div>
      ) : (
        <ol className="lesson-step-list" data-testid="lesson-step-list">
          {sortedSteps.map((step, idx) => (
            <li
              key={step.id}
              className={`lesson-step lesson-step--${step.type}`}
              data-testid={`lesson-step-${step.order}`}
              data-step-state={progress.stepsState[step.id] ?? 'pending'}
            >
              <header className="lesson-step__header">
                <span className="lesson-step-order">#{step.order}</span>
                <span className="lesson-step-type">
                  {t(`lessons.stepType.${step.type}`, step.type)}
                </span>
              </header>
              <StepRenderer
                step={step}
                hideNext={idx === sortedSteps.length - 1}
                onStepDone={() => progress.markStep(step.id, 'done')}
              />
            </li>
          ))}
        </ol>
      )}

      <footer className="lesson-footer">
        <button
          type="button"
          className="lesson-complete-btn"
          data-testid="lesson-complete-btn"
          disabled={!canComplete || progress.isCompleting}
          onClick={handleComplete}
        >
          {progress.isCompleting
            ? t('lessons.completing', 'Saving…')
            : canComplete
              ? t('lessons.complete', 'Complete lesson')
              : t('lessons.completeNeedMore', {
                  percent: Math.round(progress.threshold * 100),
                  defaultValue: 'Need ≥ {{percent}}% steps',
                })}
        </button>
        {completeMessage && (
          <p className="lesson-complete-msg" data-testid="lesson-complete-msg">
            {completeMessage}
          </p>
        )}
        {progress.lastSyncError && (
          <p
            className="lesson-sync-error"
            data-testid="lesson-sync-error"
            role="status"
          >
            {t('lessons.syncError', 'Progress could not be saved — will retry')}
          </p>
        )}
      </footer>
    </div>
  );
}
