/**
 * KS-3963 / ADR-119 §8 эпик A. Лендинг конкретной лекции по
 * маршруту `/lectures/:id`. Источник данных — `useLectureDetail`
 * (`GET /lectures/:id`).
 *
 * KS-3981 (ADR-119 §8 эпик E): адаптив — на ≥768px две колонки
 * (основной контент + meta-aside справа), на <768px один столбец.
 * Inline-стили заменены на CSS-классы из `lecture.css`. Бейдж
 * статуса лекции — из `.lecture-status-badge` (KS-3984).
 *
 * Поведение:
 *  - Пока загрузка — рендерится скелетон.
 *  - 401/403 → редирект на `/lectures/:id/unavailable?reason=forbidden`.
 *  - 404 → редирект на `/lectures/:id/unavailable?reason=not-found`.
 *  - Прочая ошибка → `?reason=load-failed`.
 *  - `status==='cancelled'` → редирект на `?reason=cancelled`.
 *  - Иначе — карточка лекции с CTA по статусу:
 *    * `scheduled` → текст со временем + кнопка «Когда начнётся»
 *      (статичная подсказка, без авто-обновления — это в эпике B).
 *      Если зритель — автор лекции, дополнительно ссылка «Начать»
 *      (POST `/lectures/:id/start` реализован в KS-3804, тут только
 *      ссылка на старую страницу `LectureReplayPage` через подпуть
 *      `?start=1` для совместимости со старым флоу).
 *    * `live` → CTA «Присоединиться к эфиру» → `/live/<slug>` (если
 *      есть `liveAnalysis.slug`), иначе подсказка «эфир сейчас
 *      недоступен».
 *    * `recorded` → CTA «Смотреть запись» → `/lectures/:id/replay`.
 *
 * Полноценная мини-доска (`previewFen`) появится после расширения
 * `LectureDetail` в backend; сейчас не рендерим, чтобы не вводить
 * пользователя в заблуждение пустой доской.
 */
import { useEffect } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLectureDetail } from '../hooks/useLectureDetail';

function LectureLandingSkeleton() {
  return (
    <div
      className="lecture-landing-page lecture-landing-page--loading"
      data-testid="lecture-landing-skeleton"
    >
      <div className="lecture-landing-page__skeleton">
        <div className="lecture-landing-page__skeleton-row lecture-landing-page__skeleton-row--title" />
        <div className="lecture-landing-page__skeleton-row lecture-landing-page__skeleton-row--meta" />
        <div className="lecture-landing-page__skeleton-row lecture-landing-page__skeleton-row--body" />
        <div className="lecture-landing-page__skeleton-row lecture-landing-page__skeleton-row--cta" />
      </div>
    </div>
  );
}

function formatScheduledAt(scheduledAt: string | null): string {
  if (!scheduledAt) return '';
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type LectureStatus = 'live' | 'scheduled' | 'recorded' | 'cancelled';

function statusBadgeClass(status: LectureStatus): string {
  return `lecture-status-badge lecture-status-badge--${status}`;
}

function statusLabel(
  status: LectureStatus,
  t: (k: string, def: string) => string,
): string {
  if (status === 'live') return t('lectureLanding.badge.live', 'Live');
  if (status === 'scheduled')
    return t('lectureLanding.badge.scheduled', 'Scheduled');
  if (status === 'recorded')
    return t('lectureLanding.badge.recorded', 'Recorded');
  return t('lectureLanding.badge.cancelled', 'Cancelled');
}

export function LectureLandingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { loading, lecture, error } = useLectureDetail(id);

  // Ошибки и `cancelled` уводят пользователя на отдельную страницу
  // «недоступно» — там подробные тексты по причине (KS-3964).
  useEffect(() => {
    if (!id) return;
    let reason: string | null = null;
    if (error === 'not-found') reason = 'not-found';
    else if (error === 'forbidden') reason = 'forbidden';
    else if (error === 'load-failed') reason = 'load-failed';
    else if (lecture?.status === 'cancelled') reason = 'cancelled';
    if (reason) {
      navigate(
        `/lectures/${encodeURIComponent(id)}/unavailable?reason=${reason}`,
        { replace: true },
      );
    }
  }, [id, error, lecture?.status, navigate]);

  if (!id) {
    return <Navigate to="/lectures" replace />;
  }
  if (loading) return <LectureLandingSkeleton />;
  if (error || !lecture) {
    // useEffect выше уже инициировал редирект — пока перерендер не
    // приехал, не показываем мусор.
    return <LectureLandingSkeleton />;
  }

  const status = lecture.status as LectureStatus;
  const slug = lecture.liveAnalysis?.slug ?? null;
  const scheduledAtFormatted = formatScheduledAt(lecture.scheduledAt);

  return (
    <div
      className="lecture-landing-page"
      data-testid="lecture-landing-page"
      data-status={status}
    >
      <header className="lecture-landing-page__header">
        <h1
          className="lecture-landing-page__title"
          data-testid="lecture-landing-title"
        >
          {lecture.title}
        </h1>
        <span
          className={statusBadgeClass(status)}
          data-testid="lecture-landing-status-badge"
        >
          {statusLabel(status, t)}
        </span>
      </header>

      <main className="lecture-landing-page__main">
        {/* Описание + автор. ownerUsername в LectureDetail на этом шаге
            backend не отдаёт — выводим только описание; ссылка на
            профиль автора появится в эпике B вместе с расширением
            контракта. */}
        {lecture.description && (
          <p
            className="lecture-landing-page__description"
            data-testid="lecture-landing-description"
          >
            {lecture.description}
          </p>
        )}

        {status === 'scheduled' && (
          <div
            className="lecture-landing-page__cta-block"
            data-testid="lecture-landing-scheduled"
          >
            <p className="lecture-landing-page__cta-body">
              {t(
                'lectureLanding.scheduled.body',
                'Lecture is scheduled to start at:',
              )}{' '}
              <strong>{scheduledAtFormatted || '—'}</strong>
            </p>
            {/* CTA «Когда начнётся» — статичная отметка, авто-обновление
                countdown появится в эпике B. */}
            <button
              type="button"
              disabled
              data-testid="lecture-landing-scheduled-cta"
              className="lecture-landing-page__cta lecture-landing-page__cta--disabled"
            >
              {t(
                'lectureLanding.scheduled.cta',
                'Waiting for the lecture to start…',
              )}
            </button>
          </div>
        )}

        {status === 'live' && (
          <div
            className="lecture-landing-page__cta-block"
            data-testid="lecture-landing-live"
          >
            <p className="lecture-landing-page__cta-body">
              {t('lectureLanding.live.body', 'The lecture is live right now.')}
            </p>
            {slug ? (
              <Link
                to={`/live/${encodeURIComponent(slug)}`}
                data-testid="lecture-landing-live-cta"
                className="lecture-landing-page__cta lecture-landing-page__cta--primary"
              >
                {t('lectureLanding.live.cta', 'Join broadcast')}
              </Link>
            ) : (
              <p
                data-testid="lecture-landing-live-no-slug"
                className="lecture-landing-page__cta-hint"
              >
                {t(
                  'lectureLanding.live.noSlug',
                  'The broadcast link is not ready yet. Please refresh.',
                )}
              </p>
            )}
          </div>
        )}

        {status === 'recorded' && (
          <div
            className="lecture-landing-page__cta-block"
            data-testid="lecture-landing-recorded"
          >
            <p className="lecture-landing-page__cta-body">
              {t(
                'lectureLanding.recorded.body',
                'A recording of the lecture is available.',
              )}
            </p>
            <Link
              to={`/lectures/${encodeURIComponent(id)}/replay`}
              data-testid="lecture-landing-recorded-cta"
              className="lecture-landing-page__cta lecture-landing-page__cta--primary"
            >
              {t('lectureLanding.recorded.cta', 'Watch recording')}
            </Link>
          </div>
        )}
      </main>

      {/* Aside-карточка с meta: статус, время. Расширится в эпике B
          (тренер, продолжительность, превью FEN). */}
      <aside
        className="lecture-landing-page__aside"
        data-testid="lecture-landing-aside"
      >
        <div className="lecture-landing-page__meta-row">
          <span className="lecture-landing-page__meta-label">
            {t('lectureLanding.meta.status', 'Status')}
          </span>
          <span className="lecture-landing-page__meta-value">
            <span className={statusBadgeClass(status)}>
              {statusLabel(status, t)}
            </span>
          </span>
        </div>
        {scheduledAtFormatted && (
          <div className="lecture-landing-page__meta-row">
            <span className="lecture-landing-page__meta-label">
              {t('lectureLanding.meta.startsAt', 'Starts at')}
            </span>
            <span
              className="lecture-landing-page__meta-value"
              data-testid="lecture-landing-meta-starts-at"
            >
              {scheduledAtFormatted}
            </span>
          </div>
        )}
        {slug && (
          <div className="lecture-landing-page__meta-row">
            <span className="lecture-landing-page__meta-label">
              {t('lectureLanding.meta.broadcast', 'Broadcast')}
            </span>
            <span className="lecture-landing-page__meta-value">
              <Link to={`/live/${encodeURIComponent(slug)}`}>{slug}</Link>
            </span>
          </div>
        )}
      </aside>
    </div>
  );
}
