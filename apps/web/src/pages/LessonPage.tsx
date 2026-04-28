import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CompleteLessonResponse,
  CourseWithLessonsResponse,
  LessonWithStepsResponse,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { StepRenderer } from '../components/lessons/StepRenderer';
import { useLessonProgress } from '../hooks/useLessonProgress';
import { resolveInlineText } from '../utils/inlineI18nText';

/**
 * Страница `/lessons/:courseSlug/:lessonSlug` — контейнер для шагов урока.
 *
 * - резолв slug → id урока через `getCourse(courseSlug)` и
 *   `getLesson(lessonId)` (L-07).
 * - рендер шагов через `StepRenderer` (L-08).
 * - прогресс через `useLessonProgress` (L-11): индикатор + дебаунс-апдейты
 *   шагов в API + кнопка «Завершить урок» с порогом ≥70%.
 *
 * # Режим повторения `?mode=review` (L-22, KS-1799)
 *
 * Когда query-параметр `mode=review` — урок считается «повтором»:
 * - локальный `stepsState` сбрасывается к пустому при монтировании, даже
 *   если сервер вернул прогресс («done» для всех шагов). Пользователь
 *   проходит урок заново.
 * - при завершении в `completeLesson` передаётся `quality` (0..5),
 *   вычисленный из финального `score`: ≥0.8 → quality=5 («отлично»),
 *   <0.8 → quality=0 («забыл»). Бэк (KS-1798) применяет SM-2 и вернёт
 *   `nextDueAt`/`intervalDays` в `CompleteLessonResponse`.
 * - вместо стандартного «Урок завершён!» показываем экран результата
 *   с пояснением по ≥80%-порогу «освоено».
 */

const REVIEW_MASTERY_THRESHOLD = 0.8;

/**
 * Маппинг финального `score` в SM-2 `quality` (0..5) для режима review.
 *
 * По ADR-025 §2.8: порог «освоено» — 80% шагов. На клиенте маппим в две
 * крайние точки (5 / 0), чтобы бэк (Sm2Service) принял однозначное
 * решение «оставить интервал» vs «сбросить». Если клиент не передаёт
 * `quality`, бэк сам маппит `score`, но это потеряет семантику «ученик
 * прошёл повтор» (а не просто «доля done»).
 */
export function reviewScoreToQuality(score: number): 0 | 5 {
  return score >= REVIEW_MASTERY_THRESHOLD ? 5 : 0;
}

export function LessonPage() {
  const { t } = useTranslation();
  const { courseSlug, lessonSlug } = useParams<{
    courseSlug: string;
    lessonSlug: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const isReviewMode = searchParams.get('mode') === 'review';

  const [course, setCourse] = useState<CourseWithLessonsResponse | null>(null);
  const [lesson, setLesson] = useState<LessonWithStepsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);
  /**
   * В режиме review после успешного `completeLesson` показываем экран
   * результата (скрываем шаги). Хранит SM-2-поля из `CompleteLessonResponse`,
   * чтобы отрисовать «следующий повтор через N дней».
   */
  const [reviewOutcome, setReviewOutcome] = useState<{
    score: number;
    response: CompleteLessonResponse | null;
  } | null>(null);
  /**
   * KS-2057: после успешного `completeLesson` в обычном режиме
   * показываем поздравительный оверлей (заголовок «Урок пройден!»,
   * галочка, конфетти, кнопки «К следующему уроку» / «К списку
   * уроков»). Хранит slug следующего урока (если он есть в курсе) —
   * чтобы построить ссылку без повторных запросов.
   */
  const [completionOutcome, setCompletionOutcome] = useState<{
    nextLesson: {
      slug: string;
      title: string | null | undefined;
      titleI18nKey: string;
    } | null;
  } | null>(null);

  useEffect(() => {
    if (!courseSlug || !lessonSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLesson(null);
    setCompleteMessage(null);
    setReviewOutcome(null);
    setCompletionOutcome(null);

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

  // В режиме review не передаём initialProgress — пользователь проходит
  // с нуля. Это заодно решает вопрос с «bleed»-ом серверного `done` в
  // локальный state.
  const progress = useLessonProgress({
    lessonId: lesson?.lesson.id ?? null,
    totalSteps: sortedSteps.length,
    initialProgress: isReviewMode ? null : lesson?.progress ?? null,
  });

  // Дополнительная гарантия: если hook по какой-то причине засеял state
  // (например, при ре-монтировании с тем же lessonId) — в review-режиме
  // сбрасываем его один раз после загрузки урока.
  const reviewResetDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReviewMode || !lesson?.lesson.id) return;
    if (reviewResetDoneRef.current === lesson.lesson.id) return;
    progress.resetProgress();
    reviewResetDoneRef.current = lesson.lesson.id;
  }, [isReviewMode, lesson?.lesson.id, progress]);

  // KS-2041: режим «один шаг — один экран». На странице рендерится
  // только активный шаг; индекс шага хранится в URL `?step=N` (N —
  // 1-based порядок, удобно для пользователя при копировании URL).
  //
  // Сценарии открытия:
  //  1. URL уже содержит `?step=N` → используем его (с зажимом в
  //     допустимый диапазон). Это покрывает back/forward и копию
  //     ссылки.
  //  2. URL без `?step=N`:
  //     - в review-режиме — всегда первый шаг (`?step=1`);
  //     - в обычном режиме — первый pending по серверному progress
  //       (продолжаем с того места, где пользователь остановился);
  //       если все done — первый шаг.
  //
  // Источник истины — `lesson.progress.stepsState` (серверное
  // состояние), а не `progress.stepsState` хука, чтобы не дёргаться
  // от оптимистичных обновлений при клике «Далее».
  const initialStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lesson?.lesson.id || sortedSteps.length === 0) return;
    if (initialStepRef.current === lesson.lesson.id) return;
    initialStepRef.current = lesson.lesson.id;

    const urlStep = searchParams.get('step');
    if (urlStep !== null) {
      // URL уже задаёт шаг — нормализуем диапазон и оставляем как есть.
      const n = parseInt(urlStep, 10);
      if (!Number.isFinite(n) || n < 1 || n > sortedSteps.length) {
        const next = new URLSearchParams(searchParams);
        next.set('step', '1');
        setSearchParams(next, { replace: true });
      }
      return;
    }

    let firstPendingIdx = 0;
    if (!isReviewMode) {
      const serverState = lesson.progress?.stepsState ?? {};
      const idx = sortedSteps.findIndex((s) => serverState[s.id] !== 'done');
      firstPendingIdx = idx >= 0 ? idx : 0;
    }

    const next = new URLSearchParams(searchParams);
    next.set('step', String(firstPendingIdx + 1));
    setSearchParams(next, { replace: true });
  }, [
    lesson?.lesson.id,
    lesson?.progress,
    sortedSteps,
    isReviewMode,
    searchParams,
    setSearchParams,
  ]);

  // Текущий индекс активного шага — производный от URL. Зажимаем
  // в `[0, sortedSteps.length - 1]`, чтобы не получить undefined-шаг
  // на крайних значениях.
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
      // При смене шага скроллим к началу страницы — длинный
      // game_review-шаг + комментарии могут оставить страницу
      // прокрученной. Без этого следующий шаг откроется «в середине».
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    [searchParams, setSearchParams, sortedSteps.length],
  );

  // KS-2041: глобальная клавиатура ← листает шаги урока назад. Чтобы не
  // конфликтовать с навигацией внутри game_review (там стрелки листают
  // ходы партии — `InlinePgnViewer`), реагируем только когда фокус НЕ
  // внутри inline-pgn-viewer'а. Также игнорируем ввод в текстовых
  // полях (input/textarea/contenteditable).
  // KS-2056: переход вперёд через клавиатуру — только если шаг уже
  // пройден (`done`). На непройденном шаге стрелка → не работает —
  // переход возможен только через «Готово».
  // KS-2076: симметрично с UI-кнопкой «Далее», стрелка → активна на
  // пройденных шагах, кроме последнего.
  useEffect(() => {
    if (sortedSteps.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((target as HTMLElement).isContentEditable) return;
      // Если фокус внутри inline-pgn-viewer (game_review) — не
      // перехватываем; viewer обрабатывает стрелки сам.
      if (target.closest('[data-testid="inline-pgn-viewer"]')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToStep(currentStepIndex - 1);
        return;
      }
      // ArrowRight — только на пройденных шагах (KS-2076).
      const activeStep = sortedSteps[currentStepIndex];
      if (!activeStep) return;
      const activeStepDone =
        progress.stepsState[activeStep.id] === 'done';
      const isLastStep = currentStepIndex >= sortedSteps.length - 1;
      if (!activeStepDone || isLastStep) return;
      e.preventDefault();
      goToStep(currentStepIndex + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentStepIndex, goToStep, sortedSteps, progress.stepsState]);

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
    const quality = isReviewMode ? reviewScoreToQuality(progress.score) : undefined;
    const outcome = await progress.completeLesson({ quality });
    if (outcome.ok) {
      if (isReviewMode) {
        setReviewOutcome({
          score: outcome.ratio,
          response: outcome.progress ?? null,
        });
      } else {
        // KS-2057: вместо короткого тоста «Lesson completed!» показываем
        // полноценный экран успеха с поздравлением и кнопкой перехода на
        // следующий урок. Слаг следующего урока ищем в текущем курсе по
        // `order` относительно текущего; если урок последний — кнопки
        // «К следующему уроку» не будет.
        const lessons = course?.lessons ?? [];
        const idx = lessons.findIndex((l) => l.slug === lesson.lesson.slug);
        const next =
          idx >= 0 && idx < lessons.length - 1 ? lessons[idx + 1] : null;
        setCompletionOutcome({
          nextLesson: next
            ? {
                slug: next.slug,
                title: next.title,
                titleI18nKey: next.titleI18nKey,
              }
            : null,
        });
      }
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

  // ─── Review: экран результата повтора ──────────────────────────────
  if (isReviewMode && reviewOutcome) {
    const scorePercent = Math.round(reviewOutcome.score * 100);
    const mastered = reviewOutcome.score >= REVIEW_MASTERY_THRESHOLD;
    const intervalDays = reviewOutcome.response?.intervalDays;
    const nextDueAt = reviewOutcome.response?.nextDueAt;

    return (
      <div
        className="lesson-page lesson-page--review-result"
        data-testid="lesson-review-result"
        data-outcome={mastered ? 'mastered' : 'reset'}
      >
        <header className="lesson-header">
          {course && (
            <Link
              to={`/lessons/${course.course.slug}`}
              className="lesson-back-link"
              data-testid="lesson-back-link"
            >
              ← {resolveInlineText(
                course.course.title,
                course.course.titleI18nKey,
                t,
                course.course.slug,
              )}
            </Link>
          )}
          <h1>
            {resolveInlineText(
              lesson.lesson.title,
              lesson.lesson.titleI18nKey,
              t,
              lesson.lesson.slug,
            )}
          </h1>
        </header>

        <div className="lesson-review-result__score">
          <div
            className="lesson-review-result__score-value"
            data-testid="lesson-review-result-score"
          >
            {t('lessons.review.resultScore', {
              score: reviewOutcome.score.toFixed(2),
              percent: scorePercent,
              defaultValue: '{{score}} ({{percent}}%)',
            })}
          </div>
        </div>

        {mastered ? (
          <p
            className="lesson-review-result__explanation lesson-review-result__explanation--mastered"
            data-testid="lesson-review-result-explanation-mastered"
          >
            {intervalDays !== undefined
              ? t('lessons.review.masteredWithInterval', {
                  count: intervalDays,
                  defaultValue:
                    'Mastered — next review in {{count}} days',
                })
              : t(
                  'lessons.review.masteredNoInterval',
                  'Mastered — next review scheduled',
                )}
          </p>
        ) : (
          <p
            className="lesson-review-result__explanation lesson-review-result__explanation--reset"
            data-testid="lesson-review-result-explanation-reset"
          >
            {t(
              'lessons.review.reset',
              'Interval reset — we will ask you to review again tomorrow',
            )}
          </p>
        )}

        {nextDueAt && (
          <p
            className="lesson-review-result__next-due"
            data-testid="lesson-review-result-next-due"
          >
            {t('lessons.review.nextDue', {
              date: new Date(nextDueAt).toLocaleDateString(),
              defaultValue: 'Next review: {{date}}',
            })}
          </p>
        )}

        <div className="lesson-review-result__actions">
          <Link
            to="/lessons"
            className="lesson-review-result__to-list"
            data-testid="lesson-review-result-back"
          >
            {t('lessons.backToList', 'All courses')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="lesson-page"
      data-testid="lesson-page"
      data-mode={isReviewMode ? 'review' : 'normal'}
    >
      <header className="lesson-header">
        {course && (
          <Link
            to={`/lessons/${course.course.slug}`}
            className="lesson-back-link"
            data-testid="lesson-back-link"
          >
            ← {resolveInlineText(
              course.course.title,
              course.course.titleI18nKey,
              t,
              course.course.slug,
            )}
          </Link>
        )}
        <h1>
          {resolveInlineText(
            lesson.lesson.title,
            lesson.lesson.titleI18nKey,
            t,
            lesson.lesson.slug,
          )}
        </h1>
        {isReviewMode && (
          <p
            className="lesson-review-banner"
            data-testid="lesson-review-banner"
          >
            {t(
              'lessons.review.banner',
              'Review mode: go through the lesson again.',
            )}
          </p>
        )}
        <p className="lesson-summary">
          {resolveInlineText(
            lesson.lesson.summary,
            lesson.lesson.summaryI18nKey,
            t,
            '',
          )}
        </p>
      </header>

      {/* KS-1991/KS-2041: прогресс прилипает под глобальный header,
          чтобы при перелистывании шагов пользователь всегда видел свою
          позицию. После KS-2041 прогресс-bar показывает позицию по
          шагу (current/total), а текст рядом — пройдено / всего. */}
      <div
        className="lesson-progress-sticky"
        data-testid="lesson-progress-sticky"
      >
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
            {sortedSteps.length > 0
              ? t('lessons.lessonProgressWithStep', {
                  current: currentStepIndex + 1,
                  total: sortedSteps.length,
                  done: progress.doneCount,
                  percent,
                  defaultValue:
                    'Step {{current}}/{{total}} — {{done}}/{{total}} done ({{percent}}%)',
                })
              : t('lessons.lessonProgress', {
                  done: progress.doneCount,
                  total: progress.totalSteps,
                  percent,
                  defaultValue: '{{done}}/{{total}} steps ({{percent}}%)',
                })}
          </span>
        </div>
      </div>

      {sortedSteps.length === 0 ? (
        <div className="lessons-empty" data-testid="lesson-no-steps">
          {t('lessons.noSteps', 'No steps in this lesson yet')}
        </div>
      ) : (
        // KS-2041: один шаг = один экран. Контейнер `lesson-step-list`
        // (по историческим testid'ам) держит ровно один активный
        // `<li>`-шаг — выбранный по `?step=N` в URL. Кнопки
        // «Назад/Далее» под ним переключают активный шаг.
        <ol className="lesson-step-list" data-testid="lesson-step-list">
          {(() => {
            const step = sortedSteps[currentStepIndex];
            if (!step) return null;
            const isLast = currentStepIndex === sortedSteps.length - 1;
            const handleStepDone = () => {
              // Помечаем текущий шаг done. На последнем шаге не
              // переключаемся автоматически — пользователь должен
              // увидеть состояние и нажать «Завершить урок» (footer).
              progress.markStep(step.id, 'done');
              if (!isLast) goToStep(currentStepIndex + 1);
            };
            return (
              <li
                key={step.id}
                id={`step-${step.id}`}
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
                  onStepDone={handleStepDone}
                  stepState={progress.stepsState[step.id]}
                />
              </li>
            );
          })()}
        </ol>
      )}

      {/* KS-2041: навигация между шагами. «Назад» ведёт к предыдущему
          шагу (на первом — disabled).
          KS-2056: на непройденном шаге кнопки «Далее» НЕТ — переход
          вперёд возможен только через «Готово» внутри шага
          (`StepRenderer.onStepDone` сам переключит на следующий).
          KS-2076: при возврате через «Назад» на УЖЕ ПРОЙДЕННЫЙ шаг
          (state === 'done') кнопку «Далее» возвращаем — пользователю
          не нужно повторно нажимать «Готово», чтобы пролистать
          вперёд. На последнем шаге «Далее» не показываем (некуда
          идти, действие переехало в footer-кнопку «Завершить урок»). */}
      {sortedSteps.length > 0 && (() => {
        const activeStep = sortedSteps[currentStepIndex];
        const isLastStep = currentStepIndex >= sortedSteps.length - 1;
        const activeStepDone =
          activeStep
            ? progress.stepsState[activeStep.id] === 'done'
            : false;
        const showNext = activeStepDone && !isLastStep;
        return (
          <nav
            className="lesson-step-nav"
            data-testid="lesson-step-nav"
            aria-label={t('lessons.stepNavLabel', 'Step navigation')}
          >
            <button
              type="button"
              className="lesson-step-nav__btn lesson-step-nav__btn--prev"
              data-testid="lesson-step-nav-prev"
              onClick={() => goToStep(currentStepIndex - 1)}
              disabled={currentStepIndex === 0}
              aria-label={t('lessons.prev', 'Previous')}
            >
              ◀ {t('lessons.prev', 'Previous')}
            </button>
            <span
              className="lesson-step-nav__counter"
              data-testid="lesson-step-nav-counter"
              aria-live="polite"
            >
              {t('lessons.stepCounter', {
                current: currentStepIndex + 1,
                total: sortedSteps.length,
                defaultValue: '{{current}}/{{total}}',
              })}
            </span>
            {showNext && (
              <button
                type="button"
                className="lesson-step-nav__btn lesson-step-nav__btn--next"
                data-testid="lesson-step-nav-next"
                onClick={() => goToStep(currentStepIndex + 1)}
                aria-label={t('lessons.next', 'Next')}
              >
                {t('lessons.next', 'Next')} ▶
              </button>
            )}
          </nav>
        );
      })()}

      <footer className="lesson-footer">
        {/* KS-2078: если урок уже отмечен как пройденный (есть
            `completedAt`) — блокируем повторное нажатие. Не относится
            к режиму review: там пользователь намеренно повторяет
            пройденный урок, кнопка «Finish review» должна работать.
            Источник истины — серверный `lesson.progress.completedAt`,
            а не локальный `progress.score`: после первого прохождения
            он не сбрасывается, и блокировка переживёт перезагрузку
            страницы. */}
        {(() => {
          const alreadyCompleted =
            !isReviewMode && lesson.progress?.completedAt != null;
          const disabled =
            alreadyCompleted ||
            !canComplete ||
            progress.isCompleting;
          const label = alreadyCompleted
            ? t('lessons.completedAlready', 'Lesson already completed')
            : progress.isCompleting
              ? t('lessons.completing', 'Saving…')
              : canComplete
                ? isReviewMode
                  ? t('lessons.review.finishReview', 'Finish review')
                  : t('lessons.complete', 'Complete lesson')
                : t('lessons.completeNeedMore', {
                    percent: Math.round(progress.threshold * 100),
                    defaultValue: 'Need ≥ {{percent}}% steps',
                  });
          return (
            <button
              type="button"
              className="lesson-complete-btn"
              data-testid="lesson-complete-btn"
              data-already-completed={alreadyCompleted ? 'true' : undefined}
              disabled={disabled}
              title={
                alreadyCompleted
                  ? t(
                      'lessons.completedAlreadyTooltip',
                      'You have already completed this lesson',
                    )
                  : undefined
              }
              onClick={handleComplete}
            >
              {label}
            </button>
          );
        })()}
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

      {/* KS-2057: оверлей завершения урока. Показывается после
          успешного `completeLesson` (только обычный режим — для review
          свой экран `lesson-review-result`). Не блокирует Esc/back —
          пользователь решает, куда идти, через кнопки внизу карточки. */}
      {completionOutcome && (
        <div
          className="lesson-completion-overlay"
          data-testid="lesson-completion-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lesson-completion-title"
        >
          {/* CSS-only конфетти: 12 частиц с разной задержкой и цветом.
              При `prefers-reduced-motion: reduce` анимация выключается
              медиа-запросом в lessons.css. */}
          <div
            className="lesson-completion-confetti"
            aria-hidden="true"
            data-testid="lesson-completion-confetti"
          >
            {Array.from({ length: 16 }).map((_, i) => (
              <span
                key={i}
                className={`lesson-completion-confetti__piece lesson-completion-confetti__piece--${(i % 4) + 1}`}
                style={{
                  left: `${(i / 16) * 100}%`,
                  animationDelay: `${(i % 5) * 0.12}s`,
                }}
              />
            ))}
          </div>

          <div className="lesson-completion-card" role="document">
            <div
              className="lesson-completion-icon"
              aria-hidden="true"
              data-testid="lesson-completion-icon"
            >
              {/* SVG-галочка — рисуется штрихом по `stroke-dasharray`,
                  что даёт анимацию «прочерчивания». */}
              <svg viewBox="0 0 64 64" width="64" height="64">
                <circle
                  className="lesson-completion-icon__ring"
                  cx="32"
                  cy="32"
                  r="28"
                  fill="none"
                  strokeWidth="4"
                />
                <path
                  className="lesson-completion-icon__check"
                  d="M18 33 L28 43 L46 23"
                  fill="none"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            <h2
              id="lesson-completion-title"
              className="lesson-completion-title"
              data-testid="lesson-completion-title"
            >
              {t('lessons.completionTitle', 'Lesson complete!')}
            </h2>
            <p
              className="lesson-completion-subtitle"
              data-testid="lesson-completion-subtitle"
            >
              {t('lessons.completionSubtitle', {
                lesson: resolveInlineText(
                  lesson.lesson.title,
                  lesson.lesson.titleI18nKey,
                  t,
                  lesson.lesson.slug,
                ),
                defaultValue: 'You finished “{{lesson}}”. Great job!',
              })}
            </p>

            <div className="lesson-completion-actions">
              {completionOutcome.nextLesson && course && (
                <Link
                  to={`/lessons/${course.course.slug}/${completionOutcome.nextLesson.slug}`}
                  className="lesson-completion-btn lesson-completion-btn--primary"
                  data-testid="lesson-completion-next"
                >
                  {t('lessons.completionNext', 'Next lesson')} ▶
                </Link>
              )}
              <Link
                to={course ? `/lessons/${course.course.slug}` : '/lessons'}
                className="lesson-completion-btn lesson-completion-btn--secondary"
                data-testid="lesson-completion-to-list"
              >
                {t('lessons.completionToList', 'Back to lessons')}
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
