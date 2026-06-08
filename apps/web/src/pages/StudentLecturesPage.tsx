/**
 * KS-3968 / ADR-119 §8 эпик B (B03). Ученический режим страницы
 * «Мои лекции» — три секции:
 *   1. «Идут сейчас» (`status='live'`) — CTA «Присоединиться»;
 *   2. «Запланированные» (`status='scheduled'`) — CTA «Открыть»
 *      (счётчик/уведомления в эпике C);
 *   3. «Записи» (`status='recorded'`) — CTA «Смотреть запись».
 *
 * Источник — `useMyLectures` (KS-3966), вызывается трижды с
 * разными `status`. Это дороже одного «общего» запроса, но даёт
 * независимые пагинации и нативные «пусто/загрузка/ошибка» в
 * каждой секции. На ученическом списке объём небольшой — три
 * запроса по 10 элементов не считаются нагрузкой.
 *
 * У ученика нет mutate-действий (Start/End/Settings/Delete не
 * показываем), `⋮`-меню тренера не нужно. Стили — функциональный
 * inline-уровень, под KS-3980 проставлены `data-testid`.
 */
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LectureStatus, LectureSummary } from '@kingside/shared';
import { useMyLectures } from '../hooks/useMyLectures';
import { useAuth } from '../context/AuthContext';

const SECTION_LIMIT = 10;

function statusBadgeClass(status: LectureStatus): string {
  return `lecture-status-badge lecture-status-badge--${status}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SectionProps {
  status: LectureStatus;
  titleKey: string;
  titleFallback: string;
  renderCard: (lecture: LectureSummary) => ReactNode;
  emptyKey: string;
  emptyFallback: string;
}

function LectureSection({
  status,
  titleKey,
  titleFallback,
  renderCard,
  emptyKey,
  emptyFallback,
}: SectionProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { items, loading, loadingMore, hasMore, error, loadMore } =
    useMyLectures({ status, limit: SECTION_LIMIT });

  // KS-3999. В ученическом разделе исключаем собственные лекции
  // (с `ownerId === user.id`) — они показываются в тренерском
  // блоке `MyLecturesPage`. Так пользователь не видит одни и те
  // же карточки дважды в разделе «Как преподаватель» и «Как
  // ученик». Для гостя (user === null) фильтр не применяется —
  // там у backend другая ветка ответа.
  const filteredItems = useMemo(() => {
    if (!user) return items;
    return items.filter((l) => l.ownerId !== user.id);
  }, [items, user]);

  return (
    <section
      className="student-lectures-page__section"
      data-testid={`student-lectures-section-${status}`}
      data-status={status}
      style={{ marginBottom: 28 }}
    >
      <h2 style={{ marginBottom: 12 }}>{t(titleKey, titleFallback)}</h2>
      {loading && (
        <div
          data-testid={`student-lectures-loading-${status}`}
          style={{ opacity: 0.7 }}
        >
          {t('common.loading', 'Loading…')}
        </div>
      )}
      {error && !loading && (
        <div
          className="error"
          data-testid={`student-lectures-error-${status}`}
        >
          {t(
            'studentLectures.error',
            'Failed to load lectures. Please try again.',
          )}
        </div>
      )}
      {!loading && !error && filteredItems.length === 0 && (
        <div
          data-testid={`student-lectures-empty-${status}`}
          style={{ opacity: 0.7, padding: '8px 0' }}
        >
          {t(emptyKey, emptyFallback)}
        </div>
      )}
      {!loading && !error && filteredItems.length > 0 && (
        <ul
          data-testid={`student-lectures-list-${status}`}
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: 12,
          }}
        >
          {filteredItems.map((lecture) => (
            <li
              key={lecture.id}
              data-testid={`student-lectures-item-${lecture.id}`}
              data-status={lecture.status}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                padding: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              {renderCard(lecture)}
            </li>
          ))}
        </ul>
      )}
      {hasMore && !loading && !error && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
            data-testid={`student-lectures-load-more-${status}`}
            style={{ padding: '6px 14px' }}
          >
            {loadingMore
              ? t('common.loading', 'Loading…')
              : t('studentLectures.loadMore', 'Show more')}
          </button>
        </div>
      )}
    </section>
  );
}

export function StudentLecturesPage() {
  const { t } = useTranslation();

  return (
    <div
      className="student-lectures-page"
      data-testid="student-lectures-page"
      data-mode="student"
      style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}
    >
      <h1 style={{ marginBottom: 24 }}>
        {t('studentLectures.title', 'My lectures')}
      </h1>

      <LectureSection
        status="live"
        titleKey="studentLectures.sectionLive"
        titleFallback="Live now"
        emptyKey="studentLectures.emptyLive"
        emptyFallback="No live lectures right now."
        renderCard={(lecture) => {
          const slug = lecture.liveAnalysis?.slug ?? null;
          return (
            <>
              <span className={statusBadgeClass(lecture.status)}>
                {t('lectureLanding.badge.live', 'Live')}
              </span>
              <span style={{ flex: '1 1 240px', fontWeight: 600 }}>
                {lecture.title}
              </span>
              {slug ? (
                <Link
                  to={`/live/${encodeURIComponent(slug)}`}
                  data-testid={`student-lectures-join-${lecture.id}`}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: '#1976d2',
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  {t('studentLectures.join', 'Join')}
                </Link>
              ) : (
                <Link
                  to={`/lectures/${encodeURIComponent(lecture.id)}`}
                  data-testid={`student-lectures-open-${lecture.id}`}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid #1976d2',
                    color: '#1976d2',
                    background: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  {t('studentLectures.open', 'Open')}
                </Link>
              )}
            </>
          );
        }}
      />

      <LectureSection
        status="scheduled"
        titleKey="studentLectures.sectionScheduled"
        titleFallback="Scheduled"
        emptyKey="studentLectures.emptyScheduled"
        emptyFallback="No upcoming lectures."
        renderCard={(lecture) => (
          <>
            <span className={statusBadgeClass(lecture.status)}>
              {t('lectureLanding.badge.scheduled', 'Scheduled')}
            </span>
            <span style={{ flex: '1 1 240px', fontWeight: 600 }}>
              {lecture.title}
            </span>
            <span style={{ fontSize: 12, opacity: 0.75, minWidth: 150 }}>
              {formatDate(lecture.scheduledAt)}
            </span>
            <Link
              to={`/lectures/${encodeURIComponent(lecture.id)}`}
              data-testid={`student-lectures-open-${lecture.id}`}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid #1976d2',
                color: '#1976d2',
                background: '#fff',
                textDecoration: 'none',
              }}
            >
              {t('studentLectures.open', 'Open')}
            </Link>
          </>
        )}
      />

      <LectureSection
        status="recorded"
        titleKey="studentLectures.sectionRecorded"
        titleFallback="Recordings"
        emptyKey="studentLectures.emptyRecorded"
        emptyFallback="No recordings available yet."
        renderCard={(lecture) => (
          <>
            <span className={statusBadgeClass(lecture.status)}>
              {t('lectureLanding.badge.recorded', 'Recorded')}
            </span>
            <span style={{ flex: '1 1 240px', fontWeight: 600 }}>
              {lecture.title}
            </span>
            <span style={{ fontSize: 12, opacity: 0.75, minWidth: 150 }}>
              {formatDate(lecture.endedAt ?? lecture.createdAt)}
            </span>
            <Link
              to={`/lectures/${encodeURIComponent(lecture.id)}/replay`}
              data-testid={`student-lectures-watch-${lecture.id}`}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: '#1976d2',
                color: '#fff',
                textDecoration: 'none',
              }}
            >
              {t('studentLectures.watch', 'Watch')}
            </Link>
          </>
        )}
      />
    </div>
  );
}
