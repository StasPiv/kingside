/**
 * KS-4192 / ADR-128 §7.6.1.2 L1.UI. Карточка публичной лекции в
 * каталоге `/lectures` для гостей и в блоке «Discover public lectures»
 * у авторизованных.
 *
 * Структура:
 *  - превью доски по `previewFen` (если есть) или statique og-image
 *    `/og/lecture.png`;
 *  - бейдж статуса (LIVE / Scheduled <date> / Recorded);
 *  - заголовок (line-clamp 2);
 *  - ссылка на тренера → `/coach/:username`;
 *  - description (line-clamp 2);
 *  - длительность для `recorded`.
 *
 * Никаких «забронировать» / `priceCents`: публичная витрина с
 * единственным CTA «открыть лекцию» — клик карточки ведёт на
 * `/lectures/:id`.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

import type { PublicLecture } from '../../api/publicLectures';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(durationMs: number | null): string {
  if (!durationMs || durationMs <= 0) return '';
  const totalMin = Math.round(durationMs / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface PublicLectureCardProps {
  lecture: PublicLecture;
}

export function PublicLectureCard({ lecture }: PublicLectureCardProps) {
  const { t, i18n } = useTranslation();
  const fen = lecture.previewFen ?? STARTING_FEN;
  const lectureHref = `/lectures/${encodeURIComponent(lecture.id)}`;
  const coachHref = `/coach/${encodeURIComponent(lecture.coach.username)}`;

  const statusLabel = (() => {
    if (lecture.status === 'live') {
      return t('lecturesPublic.statusLive', 'LIVE');
    }
    if (lecture.status === 'scheduled') {
      const when = formatDate(lecture.scheduledAt, i18n.language);
      return when
        ? t('lecturesPublic.statusScheduledAt', 'Scheduled · {{when}}', { when })
        : t('lecturesPublic.statusScheduled', 'Scheduled');
    }
    // recorded
    return t('lecturesPublic.statusRecorded', 'Recorded');
  })();

  const duration =
    lecture.status === 'recorded' ? formatDuration(lecture.durationMs) : '';

  return (
    <article
      className={`public-lecture-card public-lecture-card--${lecture.status}`}
      data-testid={`public-lecture-card-${lecture.id}`}
    >
      <Link
        to={lectureHref}
        className="public-lecture-card__board-link"
        aria-label={lecture.title}
      >
        <div className="public-lecture-card__board">
          <Chessboard
            options={{
              position: fen,
              allowDragging: false,
              animationDurationInMs: 0,
              showNotation: false,
            }}
          />
        </div>
        <span
          className={`public-lecture-card__status-badge public-lecture-card__status-badge--${lecture.status}`}
        >
          {statusLabel}
        </span>
      </Link>

      <div className="public-lecture-card__body">
        <Link to={lectureHref} className="public-lecture-card__title-link">
          <h3 className="public-lecture-card__title">{lecture.title}</h3>
        </Link>

        <Link to={coachHref} className="public-lecture-card__coach">
          {lecture.coach.username}
        </Link>

        {lecture.description && (
          <p className="public-lecture-card__description">
            {lecture.description}
          </p>
        )}

        {duration && (
          <div className="public-lecture-card__meta">
            <span className="public-lecture-card__duration">{duration}</span>
          </div>
        )}
      </div>
    </article>
  );
}
