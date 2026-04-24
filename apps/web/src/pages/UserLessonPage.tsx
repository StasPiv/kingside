import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LessonStep,
  UserCourseWithLessonsResponse,
  UserLessonDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
} from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { StepRenderer } from '../components/lessons/StepRenderer';
import { useUserLessonProgress } from '../hooks/useUserLessonProgress';

/**
 * `UserLessonPage` — прохождение одного урока пользовательского курса
 * (ADR-026 §2.6, KS-1839 / FE-5).
 *
 * Маршрут: `/lessons/my/:slug/:lessonId`. Внутри:
 *  1. Резолвим курс через `getBySlug(slug)` — чтобы получить список
 *     уроков (для навигации «следующий урок» и breadcrumbs).
 *  2. Подгружаем шаги через `getLesson(lessonId)`.
 *  3. Шаги рендерим через существующий `<StepRenderer>` — он уже умеет
 *     все 6 типов; user-курсы ограничены 3-мя (`text | puzzle |
 *     endgame_drill`), остальные в payload'е просто не появятся.
 *  4. Прогресс — через `useUserLessonProgress` (debounced POST step +
 *     complete с порогом 70%).
 *
 * На «complete» → навигация к следующему уроку (или к курсу, если
 * текущий был последним).
 */

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Приводит `UserLessonStepDto` к shape'у `LessonStep`, который ждёт
 * `StepRenderer`. Поле `lessonId` отличается по имени (`userLessonId`),
 * но остальное идентично.
 */
function stepDtoToLessonStep(dto: UserLessonStepDto): LessonStep {
  return {
    id: dto.id,
    lessonId: dto.userLessonId,
    order: dto.order,
    type: dto.type,
    payload: dto.payload,
  };
}

// ─── Page ──────────────────────────────────────────────────────────────

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | {
      kind: 'ready';
      lesson: UserLessonDto;
      steps: LessonStep[];
      /** Список всех уроков курса — нужен для «следующий урок»-навигации. */
      courseLessons: UserLessonDto[];
      courseSlug: string;
    };

export function UserLessonPage() {
  const { slug, lessonId } = useParams<{ slug: string; lessonId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);

  // Параллельно: course (для списка lessons) + lesson (для шагов).
  useEffect(() => {
    if (!slug || !lessonId) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([
      userCoursesApi.getBySlug(slug),
      userCoursesApi.getLesson(lessonId),
    ])
      .then(
        ([
          courseRes,
          lessonRes,
        ]: [UserCourseWithLessonsResponse, UserLessonWithStepsResponse]) => {
          if (cancelled) return;
          // Проверяем, что урок реально относится к этому курсу.
          const belongsToCourse = courseRes.lessons.some(
            (l) => l.id === lessonRes.lesson.id,
          );
          if (!belongsToCourse) {
            setState({ kind: 'not_found' });
            return;
          }
          setState({
            kind: 'ready',
            lesson: lessonRes.lesson,
            steps: lessonRes.steps
              .slice()
              .sort((a, b) => a.order - b.order)
              .map(stepDtoToLessonStep),
            courseLessons: courseRes.lessons
              .slice()
              .sort((a, b) => a.order - b.order),
            courseSlug: courseRes.course.slug,
          });
        },
      )
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'not_found' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, lessonId]);

  // Hook работает с текущим lessonId — даже до ready-state.
  // `userLessonId` в hook'е — string|null, поэтому ok.
  const totalSteps = state.kind === 'ready' ? state.steps.length : 0;
  const progress = useUserLessonProgress({
    userLessonId: state.kind === 'ready' ? state.lesson.id : null,
    totalSteps,
  });

  const canComplete = progress.score >= progress.threshold;

  const nextLessonId = useMemo(() => {
    if (state.kind !== 'ready') return null;
    const idx = state.courseLessons.findIndex((l) => l.id === state.lesson.id);
    if (idx === -1 || idx >= state.courseLessons.length - 1) return null;
    return state.courseLessons[idx + 1].id;
  }, [state]);

  const handleComplete = async () => {
    setCompleteMessage(null);
    const outcome = await progress.completeLesson();
    if (!outcome.ok) {
      if (outcome.error) {
        setCompleteMessage(t('lessons.completeError', 'Could not save lesson'));
        return;
      }
      setCompleteMessage(
        t('lessons.completeBelowThreshold', {
          percent: Math.round(outcome.threshold * 100),
          defaultValue:
            'To complete the lesson, finish ≥ {{percent}}% of steps',
        }),
      );
      return;
    }
    // Успех — навигация к следующему уроку, если есть; иначе — к курсу.
    if (state.kind === 'ready') {
      if (nextLessonId) {
        navigate(`/lessons/my/${state.courseSlug}/${nextLessonId}`);
      } else {
        navigate(`/lessons/my/${state.courseSlug}`);
      }
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="loading" data-testid="user-lesson-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (state.kind === 'not_found') {
    return (
      <div className="user-lesson-404" data-testid="user-lesson-404">
        <h1>{t('lessons.lessonNotFound', 'Lesson not found')}</h1>
        <Link to="/lessons" data-testid="user-lesson-404-back">
          {t('lessons.backToList', 'Back to lessons')}
        </Link>
      </div>
    );
  }

  const { lesson, steps, courseSlug } = state;
  const donePercent = Math.round(progress.score * 100);

  return (
    <div className="user-lesson-page" data-testid="user-lesson-page">
      <nav className="user-lesson-page__breadcrumbs">
        <Link to="/lessons">{t('lessons.title')}</Link>
        <span className="user-lesson-page__sep">/</span>
        <Link to={`/lessons/my/${courseSlug}`}>
          {t('lessons.backToList', 'Back to course')}
        </Link>
      </nav>

      <header className="user-lesson-page__header">
        <h1 data-testid="user-lesson-title">{lesson.title}</h1>
        <div className="user-lesson-page__progress" data-testid="user-lesson-progress">
          {t('lessons.progressFull', {
            done: progress.doneCount,
            total: progress.totalSteps,
            percent: donePercent,
            defaultValue: '{{done}}/{{total}} steps ({{percent}}%)',
          })}
        </div>
      </header>

      {steps.length === 0 ? (
        <div
          className="lessons-empty"
          data-testid="user-lesson-no-steps"
        >
          {t('lessons.noSteps', 'No steps in this lesson yet')}
        </div>
      ) : (
        <ol className="lesson-step-list" data-testid="user-lesson-step-list">
          {steps.map((step, idx) => (
            <li
              key={step.id}
              className={`lesson-step lesson-step--${step.type}`}
              data-testid={`user-lesson-step-${step.order}`}
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
                hideNext={idx === steps.length - 1}
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
          data-testid="user-lesson-complete-btn"
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
          <p
            className="lesson-complete-msg"
            data-testid="user-lesson-complete-msg"
          >
            {completeMessage}
          </p>
        )}
        {progress.lastSyncError && (
          <p
            className="lesson-sync-error"
            data-testid="user-lesson-sync-error"
            role="status"
          >
            {t('lessons.syncError', 'Progress could not be saved — will retry')}
          </p>
        )}
      </footer>
    </div>
  );
}
