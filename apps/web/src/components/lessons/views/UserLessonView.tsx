import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LessonStep,
  LessonStepState,
  UserLessonDto,
  UserLessonStepDto,
} from '@kingside/shared';

import { StepRenderer } from '../StepRenderer';
import { useStockfish } from '../../../hooks/useStockfish';
import { useLessonProgress } from '../../../hooks/useLessonProgress';
import { useFocusMode } from '../../../context/FocusModeContext';

/**
 * `UserLessonView` — UI прохождения одного урока пользовательского курса.
 *
 * KS-2645 (ADR-054 Phase D): раньше был страницей `UserLessonPage` на
 * маршруте `/lessons/my/:slug/:lessonId`. Теперь — внутренний компонент,
 * рендерится из `LessonPage`, когда тот по типу курса понимает что урок
 * пользовательский. Маршрут `/lessons/my/:slug/:lessonId` редиректит
 * на `/lessons/:slug/:lessonId` (см. App.tsx).
 *
 * Загрузка урока и навигация по шагам делаются здесь — приходят
 * `lesson`, `steps`, `courseLessons` от родителя одним батчем.
 */

interface UserLessonViewProps {
  courseSlug: string;
  lesson: UserLessonDto;
  steps: UserLessonStepDto[];
  /** Все уроки курса — нужны для «следующий урок»-навигации. */
  courseLessons: UserLessonDto[];
  /** Серверный seed `stepsState` (KS-1880 / KS-1879). */
  initialStepsState: Record<string, LessonStepState> | undefined;
}

/**
 * Приводит `UserLessonStepDto` к shape'у `LessonStep`, который ждёт
 * `StepRenderer`. Поле `lessonId` отличается по имени (`userLessonId`),
 * остальное идентично.
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

export function UserLessonView({
  courseSlug,
  lesson,
  steps: rawSteps,
  courseLessons,
  initialStepsState,
}: UserLessonViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [completeMessage, setCompleteMessage] = useState<string | null>(null);

  const sortedSteps = useMemo(
    () =>
      rawSteps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map(stepDtoToLessonStep),
    [rawSteps],
  );

  const totalSteps = sortedSteps.length;
  const progress = useLessonProgress({
    lessonId: lesson.id,
    totalSteps,
    initialStepsState,
  });

  // KS-1842: префетч Stockfish если есть endgame_drill — экономия 1-2с
  // при первой загрузке шага.
  const hasEndgameDrill = useMemo(
    () => sortedSteps.some((s) => s.type === 'endgame_drill'),
    [sortedSteps],
  );
  useStockfish({ prefetch: hasEndgameDrill });

  // KS-2629: «один шаг — одна страница». URL `?step=N` (1-based).
  // Источник истины для seed'а — серверный `initialStepsState`,
  // не оптимистичные обновления хука.
  const initialStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (sortedSteps.length === 0) return;
    if (initialStepRef.current === lesson.id) return;
    initialStepRef.current = lesson.id;

    const urlStep = searchParams.get('step');
    if (urlStep !== null) {
      const n = parseInt(urlStep, 10);
      if (!Number.isFinite(n) || n < 1 || n > sortedSteps.length) {
        const next = new URLSearchParams(searchParams);
        next.set('step', '1');
        setSearchParams(next, { replace: true });
      }
      return;
    }

    const serverState = initialStepsState ?? {};
    const idx = sortedSteps.findIndex((s) => serverState[s.id] !== 'done');
    const firstPendingIdx = idx >= 0 ? idx : 0;

    const next = new URLSearchParams(searchParams);
    next.set('step', String(firstPendingIdx + 1));
    setSearchParams(next, { replace: true });
  }, [lesson.id, sortedSteps, initialStepsState, searchParams, setSearchParams]);

  const currentStepIndex = useMemo(() => {
    if (sortedSteps.length === 0) return 0;
    const raw = parseInt(searchParams.get('step') ?? '1', 10);
    const oneBased = Number.isFinite(raw) ? raw : 1;
    const clamped = Math.min(Math.max(oneBased, 1), sortedSteps.length);
    return clamped - 1;
  }, [searchParams, sortedSteps.length]);

  const goToStep = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= sortedSteps.length) return;
      const next = new URLSearchParams(searchParams);
      next.set('step', String(idx + 1));
      setSearchParams(next);
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    [searchParams, setSearchParams, sortedSteps.length],
  );

  const canComplete = progress.score >= progress.threshold;

  const nextLessonId = useMemo(() => {
    const idx = courseLessons.findIndex((l) => l.id === lesson.id);
    if (idx === -1 || idx >= courseLessons.length - 1) return null;
    return courseLessons[idx + 1].id;
  }, [courseLessons, lesson.id]);

  // KS-2652: при переходах между уроками / возврате на курс сохраняем
  // `?preview=1`, если автор сейчас в preview-режиме. Иначе — на курсе
  // его сбрасывает обычный URL.
  const previewActive = searchParams.get('preview') === '1';
  const previewSuffix = previewActive ? '?preview=1' : '';

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
    // Сохраняем preview-флаг (см. KS-2652).
    if (nextLessonId) {
      navigate(`/lessons/${courseSlug}/${nextLessonId}${previewSuffix}`);
    } else {
      navigate(`/lessons/${courseSlug}${previewSuffix}`);
    }
  };

  const donePercent = Math.round(progress.score * 100);
  // KS-3189 (ADR-073 §7 F2): в focus-mode урок скрывает breadcrumbs,
  // заголовок, бейдж шага и обычный sticky-прогресс — освобождает ≈100px
  // вертикали под доску. Реальное переключение делает CSS через класс
  // `.user-lesson-page--focus` + `@media (max-width: 767px)`. На desktop
  // active=true ничего не меняет (как и в KS-3188).
  const { active: focusModeActive } = useFocusMode();

  return (
    <div
      className={`user-lesson-page${focusModeActive ? ' user-lesson-page--focus' : ''}`}
      data-testid="user-lesson-page"
      data-focus-mode={focusModeActive ? 'true' : 'false'}
    >
      <nav className="user-lesson-page__breadcrumbs">
        <Link to="/lessons">{t('lessons.title')}</Link>
        <span className="user-lesson-page__sep">/</span>
        <Link to={`/lessons/${courseSlug}${previewSuffix}`}>
          {t('lessons.backToList', 'Back to course')}
        </Link>
      </nav>

      <header className="user-lesson-page__header">
        <h1 data-testid="user-lesson-title">{lesson.title}</h1>
      </header>

      {/* KS-1991: прогресс «прилипает» под глобальный fixed-header.
          KS-3189: в focus-mode этот блок скрывается через CSS
          (`.user-lesson-page--focus .lesson-progress-sticky { display:none }`),
          вместо него ниже рендерится мини-pill 28px. */}
      {sortedSteps.length > 0 && (
        <div
          className="lesson-progress-sticky"
          data-testid="user-lesson-progress-sticky"
        >
          <div
            className="user-lesson-page__progress"
            data-testid="user-lesson-progress"
          >
            {t('lessons.lessonProgressWithStep', {
              current: currentStepIndex + 1,
              total: progress.totalSteps,
              done: progress.doneCount,
              percent: donePercent,
              defaultValue:
                'Step {{current}}/{{total}} — {{done}}/{{total}} done ({{percent}}%)',
            })}
          </div>
        </div>
      )}

      {/* KS-3189 (ADR-073 §7 F2): мини-pill прогресса для focus-mode.
          На обычном layout скрыт CSS'ом; в focus-mode виден вместо
          `.lesson-progress-sticky`. ~28px высоты — текст «Шаг N/M» +
          узкий progress-bar. */}
      {sortedSteps.length > 0 && (
        <div
          className="lesson-progress-pill"
          data-testid="user-lesson-progress-pill"
          aria-hidden={!focusModeActive}
        >
          <span
            className="lesson-progress-pill__label"
            data-testid="user-lesson-progress-pill-label"
          >
            {t('lessons.lessonProgressShort', {
              current: currentStepIndex + 1,
              total: progress.totalSteps,
              defaultValue: 'Step {{current}}/{{total}}',
            })}
          </span>
          <span
            className="lesson-progress-pill__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={donePercent}
          >
            <span
              className="lesson-progress-pill__fill"
              style={{ width: `${donePercent}%` }}
            />
          </span>
        </div>
      )}

      {sortedSteps.length === 0 ? (
        // KS-1892: empty-state для урока без шагов.
        <div
          className="user-lesson-empty"
          data-testid="user-lesson-no-steps"
          role="status"
        >
          <div className="user-lesson-empty__icon" aria-hidden="true">
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
            to={`/lessons/${courseSlug}${previewSuffix}`}
            className="user-lesson-empty__back"
            data-testid="user-lesson-empty-back"
          >
            {t('lessons.emptyLesson.back', 'Back to course')}
          </Link>
        </div>
      ) : (
        // KS-2629: один шаг = один экран.
        <ol className="lesson-step-list" data-testid="user-lesson-step-list">
          {(() => {
            const step = sortedSteps[currentStepIndex];
            if (!step) return null;
            const isLast = currentStepIndex === sortedSteps.length - 1;
            const handleStepDone = () => {
              progress.markStep(step.id, 'done');
              if (!isLast) goToStep(currentStepIndex + 1);
            };
            return (
              <li
                key={step.id}
                id={`step-${step.id}`}
                className={`lesson-step lesson-step--${step.type}`}
                data-testid={`user-lesson-step-${step.order}`}
                data-step-state={progress.stepsState[step.id] ?? 'pending'}
              >
                <header className="lesson-step__header">
                  {/* KS-3192: `step.order` хранится 0-based в БД (первый
                      шаг = 0); ученик видит «#0 ПАРТИЯ» — выглядит как
                      баг. Отображаемая нумерация 1-based, без правок API.
                      `data-testid` остаётся по сырому `step.order`, чтобы
                      существующие e2e/unit тесты по нему не сломались. */}
                  <span className="lesson-step-order">#{step.order + 1}</span>
                  <span className="lesson-step-type">
                    {t(`lessons.stepType.${step.type}`, step.type)}
                  </span>
                </header>
                <StepRenderer
                  step={step}
                  onStepDone={handleStepDone}
                  stepState={progress.stepsState[step.id]}
                />
              </li>
            );
          })()}
        </ol>
      )}

      {/* KS-1892: для пустого урока кнопку «Complete» не показываем. */}
      {sortedSteps.length > 0 && (
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
