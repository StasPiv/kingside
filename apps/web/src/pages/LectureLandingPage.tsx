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
import { SeoHelmet } from '../components/seo/SeoHelmet';
// KS-4646: блок «More lectures» — 4-6 ссылок на другие публичные
// лекции под основным контентом лендинга. Усиливает обход
// `/lectures/<uuid>` Googlebot'ом изнутри карточки конкретной лекции.
import { MoreLecturesBlock } from '../components/lectures/MoreLecturesBlock';

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

  // KS-4192 / KS-4220 / ADR-128 §7.6.1.2 L2. SEO на лендинге лекции.
  // С KS-4219 `LectureDetail` отдаёт `coach: { id, username } | null`,
  // поэтому `seoCoach` теперь реальный username (или пустая строка для
  // системных лекций без owner). i18n-шаблоны `seo.lectures.detail.*`
  // умеют склеить «{title} — by {coach} — Kingside»: если coach пустой,
  // строка деградирует естественно (см. truncate в SeoHelmet).
  // durationMin для `recorded`: ms → min. description обрезается
  // SeoHelmet'ом через truncateByWord. ogType=article.
  const seoCoach = lecture.coach?.username ?? '';
  // KS-4283: для лекции-recording поле description может быть пустым
  // или, наоборот, заканчиваться точкой. Шаблон «… by {coach}.
  // {description}. Watch …» в первом случае оставляет двойную точку
  // («. . »), во втором — тоже («.. »). Оба варианта попадают в meta
  // description и в превью при шаринге. Чистим trailing dots/whitespace
  // и переключаем i18n-context на `_noDescription`-вариант шаблона,
  // если после очистки строка пуста.
  const seoDescriptionText = (lecture.description ?? '')
    .trim()
    .replace(/\.+$/, '')
    .trimEnd();
  const seoDescriptionContext = seoDescriptionText
    ? undefined
    : 'noDescription';
  const seoDurationMin =
    lecture.durationMs && lecture.durationMs > 0
      ? Math.round(lecture.durationMs / 60000)
      : 0;
  const seoTitle = t('seo.lectures.detail.title', {
    title: lecture.title,
    coach: seoCoach,
  });
  const seoDescription =
    status === 'recorded'
      ? t('seo.lectures.detail.descriptionRecorded', {
          title: lecture.title,
          coach: seoCoach,
          description: seoDescriptionText,
          context: seoDescriptionContext,
        })
      : t('seo.lectures.detail.description', {
          title: lecture.title,
          coach: seoCoach,
          scheduledAt: scheduledAtFormatted,
          duration: seoDurationMin,
          description: seoDescriptionText,
          context: seoDescriptionContext,
        });
  const seoJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: lecture.title,
    description: lecture.description ?? undefined,
    courseMode: 'online',
    // KS-4220: provider — реальный тренер (`coach.username` из
    // `LectureDetail`, KS-4219). Для системных лекций без owner
    // остаётся fallback на Organization(Kingside) — без него Google
    // не показывает provider в SERP, что для Course-карточки плохо.
    provider: seoCoach
      ? {
          '@type': 'Person',
          name: seoCoach,
          url: `https://kingside.site/coach/${encodeURIComponent(seoCoach)}`,
        }
      : {
          '@type': 'Organization',
          name: 'Kingside',
          url: 'https://kingside.site',
        },
    url: `https://kingside.site/lectures/${encodeURIComponent(lecture.id)}`,
  };

  // KS-4217 / ADR-128 §7.6.1.2 L2. Явный canonical: страницы лекции
  // открываются по динамическому id, prerender'а нет (только client-
  // side render для бота → нужен явный URL).
  const seoCanonical = `https://kingside.site/lectures/${encodeURIComponent(lecture.id)}`;

  return (
    <div
      className="lecture-landing-page"
      data-testid="lecture-landing-page"
      data-status={status}
    >
      <SeoHelmet
        title={seoTitle}
        description={seoDescription}
        canonical={seoCanonical}
        ogType="article"
        ogImage="/og/lecture.png"
        jsonLd={seoJsonLd}
      />
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
        {/* KS-4646: активная ссылка на автора-тренера. До этого имя
            тренера фигурировало только в SEO-метаданных (`<title>`,
            JSON-LD provider) и в карточке `/lectures` каталога, но на
            самом лендинге лекции ссылки не было — пользователь не мог
            перейти к остальным материалам тренера, а Googlebot не
            находил `/coach/<handle>` отсюда. Источник имени —
            `LectureDetail.coach.username` (KS-4219). Для системных
            лекций без owner поле `null` — строку не показываем. */}
        {lecture.coach?.username && (
          <p
            className="lecture-landing-page__owner"
            data-testid="lecture-landing-owner"
            style={{ margin: '4px 0 12px', fontSize: 14, opacity: 0.9 }}
          >
            {t('lectureLanding.author', 'Coach')}:{' '}
            <Link
              to={`/coach/${encodeURIComponent(lecture.coach.username)}`}
              data-testid="lecture-landing-owner-link"
            >
              {lecture.coach.username}
            </Link>
          </p>
        )}

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

      {/* KS-4646: блок «More lectures» — 4-6 ссылок на другие
          публичные лекции (текущая исключена по id). Размещён ниже
          основной двухколоночной разметки, чтобы не конкурировать с
          CTA, но оставался в DOM до футера — Googlebot читает его в
          порядке потока. */}
      <MoreLecturesBlock excludeId={lecture.id} limit={6} />
    </div>
  );
}
