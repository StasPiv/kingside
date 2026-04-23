import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseWithLessonsResponse,
  LessonWithStepsResponse,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { StepRenderer } from '../components/lessons/StepRenderer';

/**
 * Страница `/lessons/:courseSlug/:lessonSlug` — контейнер для шагов урока (L-07).
 *
 * - резолв slug → id урока через `getCourse(courseSlug)`
 * - загрузка `getLesson(lessonId)`
 * - последовательный рендер шагов через `StepRenderer` (L-08)
 *
 * Хук прогресса (`useLessonProgress`) — задача L-11 (KS-1766). До его
 * появления `onStepDone` — no-op (кнопка «Далее» ничего не отмечает).
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

  useEffect(() => {
    if (!courseSlug || !lessonSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLesson(null);

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

  const sortedSteps = [...lesson.steps].sort((a, b) => a.order - b.order);

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
                /*
                  onStepDone подключит useLessonProgress в L-11 (KS-1766);
                  пока no-op, чтобы UI был самодостаточен.
                */
                onStepDone={() => {}}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
