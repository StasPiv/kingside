/**
 * KS-3964 / ADR-119 §8 эпик A (одновременно ADR-118 E03). Экран
 * «лекция недоступна» по маршруту `/lectures/:id/unavailable`.
 * Сюда уводит `LectureLandingPage` при ошибке загрузки или когда
 * лекция в статусе `cancelled`.
 *
 * KS-3983 (ADR-119 §8 эпик E): полноэкранный центрированный layout,
 * иконка по reason, кнопки с дизайн-токенами. Все стили — в
 * `apps/web/src/styles/lecture.css`.
 *
 * Поведение:
 *  - Текст и заголовок выбираются по `?reason=` из URL
 *    (`not-found` / `forbidden` / `load-failed` / `cancelled`).
 *    Любой неизвестный reason падает на общий fallback.
 *  - Кнопки: «На главную» и «Профиль тренера» (последняя — только
 *    если в search-params передан `?coach=<username>`). Дополнительно
 *    при `load-failed` показываем кнопку «Попробовать ещё раз» —
 *    переход обратно на `/lectures/:id` (там лендинг сделает
 *    повторный запрос через `useLectureDetail`).
 */
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type Reason = 'not-found' | 'forbidden' | 'load-failed' | 'cancelled';

function normalizeReason(raw: string | null): Reason | null {
  if (
    raw === 'not-found' ||
    raw === 'forbidden' ||
    raw === 'load-failed' ||
    raw === 'cancelled'
  ) {
    return raw;
  }
  return null;
}

/**
 * SVG-иконка по reason. Все — 24×24, `currentColor`, чтобы цвет
 * наследовался от родителя `.lecture-unavailable-page__icon`.
 */
function ReasonIcon({ reason }: { reason: Reason | null }) {
  if (reason === 'forbidden') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 10V8a6 6 0 1 1 12 0v2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <rect
          x="4"
          y="10"
          width="16"
          height="11"
          rx="2"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="12" cy="15.5" r="1.5" fill="currentColor" />
      </svg>
    );
  }
  if (reason === 'cancelled') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d="M8 8l8 8M16 8l-8 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (reason === 'load-failed') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3v6M4.2 19.8l15.6-15.6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M3 12a9 9 0 0 0 15.5 6.3M21 12a9 9 0 0 0-15.5-6.3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  // not-found / unknown — иконка лупы с вопросом
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path
        d="M20.5 20.5L17 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M9 9.5a2 2 0 1 1 3 1.7c-.6.3-1 .8-1 1.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="11" cy="14" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function LectureUnavailablePage() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const { t } = useTranslation();
  const reason = normalizeReason(search.get('reason'));
  const coach = search.get('coach');

  const heading =
    reason === 'cancelled'
      ? t('lectureUnavailable.cancelled.title', 'Lecture cancelled')
      : reason === 'not-found'
        ? t('lectureUnavailable.notFound.title', 'Lecture not found')
        : reason === 'forbidden'
          ? t(
              'lectureUnavailable.forbidden.title',
              'You don’t have access to this lecture',
            )
          : reason === 'load-failed'
            ? t(
                'lectureUnavailable.loadFailed.title',
                'Failed to load the lecture',
              )
            : t('lectureUnavailable.generic.title', 'Lecture unavailable');

  const body =
    reason === 'cancelled'
      ? t(
          'lectureUnavailable.cancelled.body',
          'The author cancelled this lecture. It will not take place.',
        )
      : reason === 'not-found'
        ? t(
            'lectureUnavailable.notFound.body',
            'The lecture link is invalid or the lecture has been removed.',
          )
        : reason === 'forbidden'
          ? t(
              'lectureUnavailable.forbidden.body',
              'This lecture is private. Ask the author to share it with you.',
            )
          : reason === 'load-failed'
            ? t(
                'lectureUnavailable.loadFailed.body',
                'Could not reach the server. Please check your connection and try again.',
              )
            : t(
                'lectureUnavailable.generic.body',
                'This lecture is not available right now.',
              );

  return (
    <div
      className="lecture-unavailable-page"
      data-testid="lecture-unavailable-page"
      data-reason={reason ?? 'unknown'}
    >
      <div
        className="lecture-unavailable-page__icon"
        data-testid="lecture-unavailable-icon"
      >
        <ReasonIcon reason={reason} />
      </div>

      <h1
        className="lecture-unavailable-page__title"
        data-testid="lecture-unavailable-title"
      >
        {heading}
      </h1>
      <p
        className="lecture-unavailable-page__body"
        data-testid="lecture-unavailable-body"
      >
        {body}
      </p>

      <div className="lecture-unavailable-page__actions">
        {reason === 'load-failed' && id && (
          <Link
            to={`/lectures/${encodeURIComponent(id)}`}
            data-testid="lecture-unavailable-retry"
            className="lecture-unavailable-page__action lecture-unavailable-page__action--primary"
          >
            {t('lectureUnavailable.retry', 'Try again')}
          </Link>
        )}
        {coach && (
          <Link
            to={`/coach/${encodeURIComponent(coach)}`}
            data-testid="lecture-unavailable-coach-link"
            className="lecture-unavailable-page__action lecture-unavailable-page__action--secondary"
          >
            {t('lectureUnavailable.coach', 'Coach profile')}
          </Link>
        )}
        <Link
          to="/"
          data-testid="lecture-unavailable-home"
          className="lecture-unavailable-page__action lecture-unavailable-page__action--tertiary"
        >
          {t('lectureUnavailable.home', 'Back to home')}
        </Link>
      </div>
    </div>
  );
}
