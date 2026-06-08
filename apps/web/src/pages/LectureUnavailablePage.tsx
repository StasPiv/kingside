/**
 * KS-3964 / ADR-119 §8 эпик A (одновременно ADR-118 E03). Экран
 * «лекция недоступна» по маршруту `/lectures/:id/unavailable`.
 * Сюда уводит `LectureLandingPage` при ошибке загрузки или когда
 * лекция в статусе `cancelled`.
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
      style={{
        padding: 16,
        maxWidth: 560,
        margin: '0 auto',
        textAlign: 'center',
      }}
    >
      <h1
        data-testid="lecture-unavailable-title"
        style={{ marginBottom: 12 }}
      >
        {heading}
      </h1>
      <p
        data-testid="lecture-unavailable-body"
        style={{ margin: '0 0 24px', opacity: 0.85, fontSize: 15 }}
      >
        {body}
      </p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          justifyContent: 'center',
        }}
      >
        {reason === 'load-failed' && id && (
          <Link
            to={`/lectures/${encodeURIComponent(id)}`}
            data-testid="lecture-unavailable-retry"
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: 'none',
              background: '#1976d2',
              color: '#fff',
              textDecoration: 'none',
            }}
          >
            {t('lectureUnavailable.retry', 'Try again')}
          </Link>
        )}
        {coach && (
          <Link
            to={`/coach/${encodeURIComponent(coach)}`}
            data-testid="lecture-unavailable-coach-link"
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: '1px solid #1976d2',
              color: '#1976d2',
              background: '#fff',
              textDecoration: 'none',
            }}
          >
            {t('lectureUnavailable.coach', 'Coach profile')}
          </Link>
        )}
        <Link
          to="/"
          data-testid="lecture-unavailable-home"
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            border: '1px solid #ddd',
            color: '#333',
            background: '#fff',
            textDecoration: 'none',
          }}
        >
          {t('lectureUnavailable.home', 'Back to home')}
        </Link>
      </div>
    </div>
  );
}
