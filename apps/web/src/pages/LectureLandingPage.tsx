/**
 * KS-3963 / ADR-119 §8 эпик A. Лендинг конкретной лекции по
 * маршруту `/lectures/:id`. Источник данных — `useLectureDetail`
 * (`GET /lectures/:id`).
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
      style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}
    >
      <div
        style={{
          height: 28,
          width: '60%',
          background: '#e5e7eb',
          borderRadius: 6,
          marginBottom: 12,
        }}
      />
      <div
        style={{
          height: 16,
          width: '40%',
          background: '#eef0f3',
          borderRadius: 6,
          marginBottom: 24,
        }}
      />
      <div
        style={{
          height: 80,
          background: '#f3f4f6',
          borderRadius: 8,
          marginBottom: 24,
        }}
      />
      <div
        style={{
          height: 40,
          width: 200,
          background: '#e5e7eb',
          borderRadius: 8,
        }}
      />
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

  const status = lecture.status;
  const slug = lecture.liveAnalysis?.slug ?? null;

  return (
    <div
      className="lecture-landing-page"
      data-testid="lecture-landing-page"
      data-status={status}
      style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}
    >
      <h1
        data-testid="lecture-landing-title"
        style={{ marginBottom: 4 }}
      >
        {lecture.title}
      </h1>
      {/* Описание + автор. ownerUsername в LectureDetail на этом шаге
          backend не отдаёт — выводим только описание; ссылка на
          профиль автора появится в эпике B вместе с расширением
          контракта. */}
      {lecture.description && (
        <p
          data-testid="lecture-landing-description"
          style={{ margin: '4px 0 16px', opacity: 0.85 }}
        >
          {lecture.description}
        </p>
      )}

      {status === 'scheduled' && (
        <div data-testid="lecture-landing-scheduled">
          <p style={{ margin: '12px 0', fontSize: 15 }}>
            {t(
              'lectureLanding.scheduled.body',
              'Lecture is scheduled to start at:',
            )}{' '}
            <strong>{formatScheduledAt(lecture.scheduledAt) || '—'}</strong>
          </p>
          {/* CTA «Когда начнётся» — статичная отметка, авто-обновление
              countdown появится в эпике B. */}
          <button
            type="button"
            disabled
            data-testid="lecture-landing-scheduled-cta"
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: '1px solid #ddd',
              background: '#f5f5f5',
              color: '#888',
              cursor: 'not-allowed',
              fontSize: 15,
            }}
          >
            {t(
              'lectureLanding.scheduled.cta',
              'Waiting for the lecture to start…',
            )}
          </button>
        </div>
      )}

      {status === 'live' && (
        <div data-testid="lecture-landing-live">
          <p style={{ margin: '12px 0', fontSize: 15 }}>
            {t('lectureLanding.live.body', 'The lecture is live right now.')}
          </p>
          {slug ? (
            <Link
              to={`/live/${encodeURIComponent(slug)}`}
              data-testid="lecture-landing-live-cta"
              style={{
                display: 'inline-block',
                padding: '10px 20px',
                borderRadius: 8,
                border: 'none',
                background: '#1976d2',
                color: '#fff',
                textDecoration: 'none',
                fontSize: 15,
              }}
            >
              {t('lectureLanding.live.cta', 'Join broadcast')}
            </Link>
          ) : (
            <p
              data-testid="lecture-landing-live-no-slug"
              style={{ opacity: 0.7 }}
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
        <div data-testid="lecture-landing-recorded">
          <p style={{ margin: '12px 0', fontSize: 15 }}>
            {t(
              'lectureLanding.recorded.body',
              'A recording of the lecture is available.',
            )}
          </p>
          <Link
            to={`/lectures/${encodeURIComponent(id)}/replay`}
            data-testid="lecture-landing-recorded-cta"
            style={{
              display: 'inline-block',
              padding: '10px 20px',
              borderRadius: 8,
              border: 'none',
              background: '#1976d2',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 15,
            }}
          >
            {t('lectureLanding.recorded.cta', 'Watch recording')}
          </Link>
        </div>
      )}
    </div>
  );
}
