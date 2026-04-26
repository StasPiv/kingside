import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LessonStep,
  LessonStepState,
  UserCourseWithLessonsResponse,
  UserLessonDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
} from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { StepRenderer } from '../components/lessons/StepRenderer';
import { useStockfish } from '../hooks/useStockfish';
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
      /**
       * Серверный seed `stepsState` для прогресс-хука (KS-1880). Если
       * пользователь уже открывал/проходил урок — backend возвращает
       * текущее состояние шагов, его и подсасываем как initialStepsState.
       * `undefined` — никогда не открывал, хук стартует с пустого `{}`.
       */
      initialStepsState: Record<string, LessonStepState> | undefined;
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
          // KS-1880: serverProgress.stepsState нужен для восстановления
          // прогресса при повторном открытии урока. Передаём его в hook
          // через `initialStepsState` (см. ниже useUserLessonProgress).
          // null/undefined → пустой state, хук стартует чистым.
          const serverStepsState = lessonRes.progress?.stepsState;
          const initialStepsState =
            serverStepsState && Object.keys(serverStepsState).length > 0
              ? serverStepsState
              : undefined;
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
            initialStepsState,
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
  // KS-1880: при ready подаём серверный seed (если есть). Передаётся
  // ровно один раз вместе с userLessonId — хук применит его в эффекте
  // смены lesson'а.
  const initialStepsState =
    state.kind === 'ready' ? state.initialStepsState : undefined;
  const progress = useUserLessonProgress({
    userLessonId: state.kind === 'ready' ? state.lesson.id : null,
    totalSteps,
    initialStepsState,
  });

  // KS-1842 (ADR-026 §2.9): если в уроке есть endgame_drill — префетчим
  // Stockfish WASM сразу при появлении шагов, чтобы к моменту когда
  // пользователь дойдёт до drill'а движок уже был загружен. Worker
  // монтируется на странице и отдельный от тех, что создаст
  // `<EndgameDrillStep>` (browser HTTP-кеш переиспользует engine JS
  // и WASM — вот где приходит 1-2 сек экономии).
  const hasEndgameDrill = useMemo(
    () =>
      state.kind === 'ready' &&
      state.steps.some((s) => s.type === 'endgame_drill'),
    [state],
  );
  useStockfish({ prefetch: hasEndgameDrill });

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
      </header>

      {/* KS-1991: прогресс «прилипает» под глобальный fixed-header,
          чтобы при скролле длинного урока счётчик шагов всегда
          оставался виден. Рендерится только если шаги есть. */}
      {steps.length > 0 && (
        <div
          className="lesson-progress-sticky"
          data-testid="user-lesson-progress-sticky"
        >
          <div
            className="user-lesson-page__progress"
            data-testid="user-lesson-progress"
          >
            {t('lessons.progressFull', {
              completed: progress.doneCount,
              total: progress.totalSteps,
              percent: donePercent,
              defaultValue: '{{completed}}/{{total}} ({{percent}}%)',
            })}
          </div>
        </div>
      )}

      {steps.length === 0 ? (
        // KS-1892: empty-state для урока без шагов. Студент мог
        // открыть только что добавленный автором урок, у которого
        // ещё нет шагов. Показываем дружелюбный блок с подсказкой
        // и кнопкой возврата к курсу — чтобы пустая лента не
        // выглядела как баг.
        <div
          className="user-lesson-empty"
          data-testid="user-lesson-no-steps"
          role="status"
        >
          <div
            className="user-lesson-empty__icon"
            aria-hidden="true"
          >
            📭
          </div>
          <h2 className="user-lesson-empty__title">
            {t('lessons.emptyLesson.title', 'This lesson has no steps yet')}
          </h2>
          <p className="user-lesson-empty__body">
            {t(
              'lessons.emptyLesson.body',
              "The author hasn't added any steps yet. Check back later.",
            )}
          </p>
          <Link
            to={`/lessons/my/${courseSlug}`}
            className="user-lesson-empty__back"
            data-testid="user-lesson-empty-back"
          >
            {t('lessons.emptyLesson.back', 'Back to course')}
          </Link>
        </div>
      ) : (
        <ol className="lesson-step-list" data-testid="user-lesson-step-list">
          {steps.map((step) => (
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
              {/* KS-1990: `hideNext` для последнего шага больше не
                  передаём — без автомаркера TextStep пользователю
                  нужен явный способ отметить шаг done. */}
              <StepRenderer
                step={step}
                onStepDone={() => progress.markStep(step.id, 'done')}
                // KS-1891: передаём текущее состояние шага, чтобы
                // TextStep показал «Пройдено ✓» при повторном
                // открытии завершённого урока (KS-1880 восстанавливает
                // stepsState с сервера).
                stepState={progress.stepsState[step.id]}
              />
            </li>
          ))}
        </ol>
      )}

      {/* KS-1892: для пустого урока (без шагов) кнопку «Complete»
          не показываем — нечего завершать. Возврат — через
          empty-state выше. */}
      {steps.length > 0 && (
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
      )}
    </div>
  );
}
