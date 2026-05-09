import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseLessonSummary } from '@kingside/shared';
import { resolveInlineText } from '../../utils/inlineI18nText';

/**
 * KS-2079: hero-плашка активного урока на странице курса.
 *
 * Логика выбора активного урока (по `progressState`):
 *  1. Если есть `in_progress` — берём первый такой (по `order`).
 *  2. Иначе если есть `not_started` — берём первый такой.
 *  3. Иначе (все `completed`) — плашка не рендерится, вместо неё
 *     блок «Курс пройден» (тоже здесь, отдельным state'ом).
 *
 * Заголовок:
 *  - in_progress → «Continue» / «Продолжить».
 *  - not_started, при этом существуют ранее пройденные уроки →
 *    «Continue» (логика «продолжить курс»).
 *  - not_started, ни одного пройденного → «Start learning» /
 *    «Начать обучение» (первый старт курса).
 */

interface CourseActiveLessonHeroProps {
  /** Слаг курса — для построения ссылки на урок. */
  courseSlug: string;
  /** Все уроки курса, отсортированные по `order` (родитель уже сортирует). */
  lessons: CourseLessonSummary[];
  /**
   * KS-2652: суффикс query (`?preview=1`), пробрасываемый в CTA-ссылку
   * для preview-режима автора. Пустая строка по умолчанию.
   */
  previewSuffix?: string;
}

type Mode = 'continue' | 'start' | 'completed';

interface ActiveLessonResolved {
  mode: 'continue' | 'start';
  lesson: CourseLessonSummary;
  positionInCourse: number; // 1-based
}

/** Возвращает активный урок + режим, либо null если все пройдены. */
export function resolveActiveLesson(
  lessons: CourseLessonSummary[],
): ActiveLessonResolved | null {
  if (lessons.length === 0) return null;
  const allCompleted = lessons.every((l) => l.progressState === 'completed');
  if (allCompleted) return null;

  const inProgress = lessons.find((l) => l.progressState === 'in_progress');
  if (inProgress) {
    return {
      mode: 'continue',
      lesson: inProgress,
      positionInCourse: lessons.indexOf(inProgress) + 1,
    };
  }
  const notStarted = lessons.find((l) => l.progressState === 'not_started');
  if (!notStarted) return null;

  // Если есть хотя бы один completed — это «продолжаем», а не первый старт.
  const hasAnyCompleted = lessons.some((l) => l.progressState === 'completed');
  return {
    mode: hasAnyCompleted ? 'continue' : 'start',
    lesson: notStarted,
    positionInCourse: lessons.indexOf(notStarted) + 1,
  };
}

export function CourseActiveLessonHero({
  courseSlug,
  lessons,
  previewSuffix = '',
}: CourseActiveLessonHeroProps) {
  const { t } = useTranslation();
  const total = lessons.length;
  const resolved = resolveActiveLesson(lessons);

  // Состояние «Курс пройден»: все уроки completed (и хоть один есть).
  const allCompleted =
    total > 0 && lessons.every((l) => l.progressState === 'completed');

  if (!resolved && allCompleted) {
    const mode: Mode = 'completed';
    return (
      <section
        className="course-active-hero course-active-hero--completed"
        data-testid="course-active-hero"
        data-mode={mode}
      >
        <span className="course-active-hero__badge course-active-hero__badge--success">
          ✓
        </span>
        <h2 className="course-active-hero__title">
          {t('lessons.activeHero.courseCompletedTitle', 'Course completed')}
        </h2>
        <p className="course-active-hero__subtitle">
          {t(
            'lessons.activeHero.courseCompletedSubtitle',
            'You have completed every lesson in this course.',
          )}
        </p>
      </section>
    );
  }

  if (!resolved) {
    // Список пуст или нет пригодного урока — плашку не рисуем.
    return null;
  }

  const { mode, lesson, positionInCourse } = resolved;
  const stepTotal = lesson.stepCount || 0;
  const stepDone = lesson.completedStepsCount ?? 0;
  const pct =
    stepTotal > 0 ? Math.min(100, Math.round((stepDone / stepTotal) * 100)) : 0;

  const lessonTitle = resolveInlineText(
    lesson.title,
    lesson.titleI18nKey,
    t,
    lesson.slug,
  );
  const lessonSubtitle = resolveInlineText(
    lesson.summary,
    lesson.summaryI18nKey,
    t,
    '',
  );

  const heroTitle =
    mode === 'continue'
      ? t('lessons.activeHero.continueTitle', 'Continue')
      : t('lessons.activeHero.startTitle', 'Start learning');
  const ctaLabel =
    mode === 'continue'
      ? t('lessons.activeHero.continueCta', 'Continue')
      : t('lessons.activeHero.startCta', 'Start lesson');

  return (
    <section
      className={`course-active-hero course-active-hero--${mode}`}
      data-testid="course-active-hero"
      data-mode={mode}
    >
      <span
        className="course-active-hero__eyebrow"
        data-testid="course-active-hero-eyebrow"
      >
        {heroTitle}
      </span>
      <h2 className="course-active-hero__title">
        <span className="course-active-hero__lesson-position">
          {t('lessons.activeHero.lessonOf', {
            defaultValue: 'Lesson {{n}} of {{total}}',
            n: positionInCourse,
            total,
          })}
        </span>
        <span
          className="course-active-hero__lesson-title"
          data-testid="course-active-hero-lesson-title"
        >
          {lessonTitle}
        </span>
      </h2>
      {lessonSubtitle && (
        <p className="course-active-hero__subtitle">{lessonSubtitle}</p>
      )}
      {stepTotal > 0 && (
        <div
          className="course-active-hero__progress"
          data-testid="course-active-hero-progress"
          aria-label={t('lessons.progressLabel', 'Course progress')}
        >
          <div className="course-active-hero__progress-bar">
            <div
              className="course-active-hero__progress-fill"
              style={{ width: `${pct}%` }}
              data-testid="course-active-hero-progress-fill"
            />
          </div>
          <span className="course-active-hero__progress-text">
            {stepDone > 0
              ? t('lessons.stepProgress', {
                  done: stepDone,
                  total: stepTotal,
                  defaultValue: '{{done}}/{{total}} steps',
                })
              : t('lessons.stepCount', {
                  count: stepTotal,
                  defaultValue: '{{count}} steps',
                })}
          </span>
        </div>
      )}
      <Link
        to={`/lessons/${courseSlug}/${lesson.slug}${previewSuffix}`}
        className="course-active-hero__cta"
        data-testid="course-active-hero-cta"
      >
        {ctaLabel}
      </Link>
    </section>
  );
}
