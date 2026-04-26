import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [searchParams] = useSearchParams();
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

  useEffect(() => {
    if (!courseSlug || !lessonSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLesson(null);
    setCompleteMessage(null);
    setReviewOutcome(null);

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

  // KS-1992: при первом открытии урока скроллим к первому шагу, который
  // ещё не отмечен `done`. Если все шаги done — остаёмся вверху страницы
  // (пользователь, возможно, зашёл за кнопкой «Завершить урок» / повторить).
  //
  // Источник истины для «начального» состояния — `lesson.progress.stepsState`
  // (то что пришло с сервера), а не `progress.stepsState` хука: hook
  // умеет обновлять локальное состояние оптимистично при кликах, и если
  // привязаться к нему, эффект ре-сработает после клика «Далее» —
  // ломая smooth-scroll из KS-1986.
  //
  // Скролл выполняется один раз на каждый load урока — флаг
  // `autoScrollDoneRef` хранит lessonId, для которого уже прокрутили.
  // В review-режиме скроллить вверх не нужно: stepsState сбрасывается,
  // первый pending — он же первый шаг.
  const autoScrollDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lesson?.lesson.id || sortedSteps.length === 0) return;
    if (autoScrollDoneRef.current === lesson.lesson.id) return;
    autoScrollDoneRef.current = lesson.lesson.id;
    if (isReviewMode) return;
    const serverState = lesson.progress?.stepsState ?? {};
    const firstPending = sortedSteps.find((s) => serverState[s.id] !== 'done');
    if (!firstPending) return;
    // Если первый pending — он же первый шаг по `order`, скроллить
    // некуда (страница и так открывается в самом верху).
    if (sortedSteps[0]?.id === firstPending.id) return;
    const el = document.getElementById(`step-${firstPending.id}`);
    el?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [lesson?.lesson.id, sortedSteps, lesson?.progress, isReviewMode]);

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
        setCompleteMessage(t('lessons.completeSuccess', 'Lesson completed!'));
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

      {/* KS-1991: прогресс «прилипает» под глобальный fixed-header,
          чтобы при скролле длинного урока пользователь всегда видел
          сколько шагов пройдено. */}
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
            {t('lessons.lessonProgress', {
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
        <ol className="lesson-step-list" data-testid="lesson-step-list">
          {sortedSteps.map((step, idx) => {
            // KS-1986: после `markStep('done')` плавно прокручиваем
            // страницу к началу следующего шага. На последнем шаге
            // следующего нет — `nextStep` undefined, скролла не будет.
            // KS-1990: кнопка «Далее» теперь рендерится и на последнем
            // шаге тоже (раньше скрывалась через `hideNext`). Без
            // автомаркера у пользователя должен быть явный способ
            // пометить любой шаг done — поэтому `hideNext` больше не
            // передаём для последнего.
            const nextStep = sortedSteps[idx + 1];
            const handleStepDone = () => {
              progress.markStep(step.id, 'done');
              if (!nextStep) return;
              const el = document.getElementById(`step-${nextStep.id}`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                />
              </li>
            );
          })}
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
              ? isReviewMode
                ? t('lessons.review.finishReview', 'Finish review')
                : t('lessons.complete', 'Complete lesson')
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
