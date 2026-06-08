/**
 * KS-3967 / ADR-119 §8 эпик B (B02). Тренерская страница «Мои
 * лекции» — таблица (desktop) или карточки (mobile) с фильтрами
 * по статусу/видимости и контекстными действиями над каждой
 * лекцией.
 *
 * Источник данных — `useMyLectures` (KS-3966 / KS-3937 backend).
 * Backend отдаёт лекции, к которым у пользователя есть доступ
 * (владелец или участник allowlist'а). На этом шаге тренерский
 * режим: предполагаем, что список содержит преимущественно
 * собственные лекции. Ученический режим, секции и переключение —
 * KS-3968 / KS-3969.
 *
 * Действия в ⋮-меню:
 *   - «Открыть» — переход на `/lectures/:id`.
 *   - «Начать» (для `scheduled`) — `POST /lectures/:id/start`,
 *     далее переход на `/live/<slug>` если backend вернул сессию;
 *     иначе refetch и оставляем пользователя на странице.
 *   - «Завершить» (для `live`) — `POST /lectures/:id/force-end`.
 *   - «Настройки» (для `scheduled/live/recorded`) — открыть
 *     `LectureToolsSettingsModal`.
 *   - «Поделиться» — копирует `/lectures/:id`-ссылку в буфер.
 *   - «Удалить» — `DELETE /lectures/:id` с подтверждением.
 *
 * KS-3980 (ADR-119 §8 эпик E): стили перенесены в `lecture.css`.
 * Desktop — grid-таблица, mobile — карточки. Фильтры — segment
 * control (кнопки). Подписи колонок в шапке таблицы видны только
 * на ≥720px; в карточках на mobile используются inline-подписи
 * перед значениями.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LectureStatus,
  LectureSummary,
  LectureVisibility,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useMyLectures } from '../hooks/useMyLectures';
import { LectureSettingsModal } from '../components/lecture/LectureSettingsModal';

type StatusFilter = LectureStatus | 'all';
type VisibilityFilter = LectureVisibility | 'all';

const STATUS_OPTIONS: ReadonlyArray<{
  value: StatusFilter;
  labelKey: string;
  fallback: string;
}> = [
  { value: 'all', labelKey: 'myLectures.filters.statusAll', fallback: 'All' },
  { value: 'scheduled', labelKey: 'lectureLanding.badge.scheduled', fallback: 'Scheduled' },
  { value: 'live', labelKey: 'lectureLanding.badge.live', fallback: 'Live' },
  { value: 'recorded', labelKey: 'lectureLanding.badge.recorded', fallback: 'Recorded' },
  { value: 'cancelled', labelKey: 'lectureLanding.badge.cancelled', fallback: 'Cancelled' },
];

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: VisibilityFilter;
  labelKey: string;
  fallback: string;
}> = [
  { value: 'all', labelKey: 'myLectures.filters.visibilityAll', fallback: 'All' },
  { value: 'public', labelKey: 'myLectures.filters.visibilityPublic', fallback: 'Public' },
  { value: 'unlisted', labelKey: 'myLectures.filters.visibilityUnlisted', fallback: 'Unlisted' },
  { value: 'restricted', labelKey: 'myLectures.filters.visibilityRestricted', fallback: 'Restricted' },
];

function statusBadgeClass(status: LectureStatus): string {
  return `lecture-status-badge lecture-status-badge--${status} lecture-status-badge--sm`;
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

interface StartLectureResponse {
  lecture: LectureSummary;
  liveAnalysis: { id: string; slug: string; url: string } | null;
}

/**
 * Универсальный segment-control. Кнопка с `aria-pressed` —
 * наиболее прозрачная семантика для группы взаимоисключающих
 * фильтров без перезагрузки страницы.
 */
function SegmentControl<T extends string>({
  testId,
  ariaLabel,
  options,
  value,
  onChange,
  renderLabel,
}: {
  testId: string;
  ariaLabel: string;
  options: ReadonlyArray<{ value: T; labelKey: string; fallback: string }>;
  value: T;
  onChange: (next: T) => void;
  renderLabel: (opt: {
    value: T;
    labelKey: string;
    fallback: string;
  }) => string;
}) {
  return (
    <div
      className="my-lectures-page__segment"
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {options.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(opt.value)}
            data-testid={`${testId}-opt-${opt.value}`}
            data-active={isActive ? 'true' : 'false'}
            className={
              'my-lectures-page__segment-btn' +
              (isActive ? ' my-lectures-page__segment-btn--active' : '')
            }
          >
            {renderLabel(opt)}
          </button>
        );
      })}
    </div>
  );
}

export function MyLecturesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [settingsLecture, setSettingsLecture] =
    useState<LectureSummary | null>(null);
  const [busyLectureId, setBusyLectureId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { items, total, hasMore, loading, loadingMore, error, loadMore, refetch } =
    useMyLectures({
      status: statusFilter === 'all' ? undefined : statusFilter,
    });

  // Клиентский фильтр по видимости. Backend KS-3937 фильтрует только
  // по `status`; visibility — допфильтр поверх загруженного списка,
  // чтобы не плодить серверных параметров до отдельного запроса
  // владельца. На больших списках в эпике C можно перенести на сервер.
  const filteredItems = useMemo(() => {
    if (visibilityFilter === 'all') return items;
    return items.filter((l) => l.visibility === visibilityFilter);
  }, [items, visibilityFilter]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const explainError = useCallback(
    (e: unknown, fallbackKey: string, fallbackText: string) => {
      if (e instanceof ApiError && e.message) return e.message;
      return t(fallbackKey, fallbackText);
    },
    [t],
  );

  const handleStart = useCallback(
    async (lecture: LectureSummary) => {
      if (busyLectureId) return;
      setBusyLectureId(lecture.id);
      try {
        const resp = await api.post<StartLectureResponse>(
          `/lectures/${encodeURIComponent(lecture.id)}/start`,
          {},
        );
        if (resp.liveAnalysis?.slug) {
          navigate(`/live/${encodeURIComponent(resp.liveAnalysis.slug)}`);
          return;
        }
        refetch();
        showToast(
          t('myLectures.actions.startedToast', 'Lecture started'),
        );
      } catch (e) {
        showToast(
          explainError(
            e,
            'myLectures.actions.startFailed',
            'Failed to start the lecture',
          ),
        );
      } finally {
        setBusyLectureId(null);
      }
    },
    [busyLectureId, navigate, refetch, t, showToast, explainError],
  );

  const handleForceEnd = useCallback(
    async (lecture: LectureSummary) => {
      if (busyLectureId) return;
      const ok = window.confirm(
        t(
          'myLectures.actions.forceEndConfirm',
          'End this lecture for all viewers?',
        ),
      );
      if (!ok) return;
      setBusyLectureId(lecture.id);
      try {
        await api.post(
          `/lectures/${encodeURIComponent(lecture.id)}/force-end`,
          {},
        );
        refetch();
        showToast(
          t('myLectures.actions.forceEndToast', 'Lecture ended'),
        );
      } catch (e) {
        showToast(
          explainError(
            e,
            'myLectures.actions.forceEndFailed',
            'Failed to end the lecture',
          ),
        );
      } finally {
        setBusyLectureId(null);
      }
    },
    [busyLectureId, refetch, t, showToast, explainError],
  );

  const handleDelete = useCallback(
    async (lecture: LectureSummary) => {
      if (busyLectureId) return;
      const ok = window.confirm(
        t(
          'myLectures.actions.deleteConfirm',
          'Delete this lecture? This cannot be undone.',
        ),
      );
      if (!ok) return;
      setBusyLectureId(lecture.id);
      try {
        await api.delete(`/lectures/${encodeURIComponent(lecture.id)}`);
        refetch();
        showToast(
          t('myLectures.actions.deletedToast', 'Lecture deleted'),
        );
      } catch (e) {
        showToast(
          explainError(
            e,
            'myLectures.actions.deleteFailed',
            'Failed to delete the lecture',
          ),
        );
      } finally {
        setBusyLectureId(null);
      }
    },
    [busyLectureId, refetch, t, showToast, explainError],
  );

  const handleShare = useCallback(
    async (lecture: LectureSummary) => {
      const url = `${window.location.origin}/lectures/${encodeURIComponent(lecture.id)}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast(
          t('myLectures.actions.copiedToast', 'Link copied'),
        );
      } catch {
        // clipboard может быть запрещён — показываем ссылку текстом.
        showToast(
          t(
            'myLectures.actions.copyFailedToast',
            'Could not copy. Link: {{url}}',
            { url },
          ),
        );
      }
    },
    [t, showToast],
  );

  return (
    <div
      className="my-lectures-page"
      data-testid="my-lectures-page"
      data-mode="coach"
    >
      <h1 className="my-lectures-page__title">
        {t('myLectures.title', 'My lectures')}
      </h1>

      <div
        className="my-lectures-page__filters"
        data-testid="my-lectures-filters"
      >
        <div className="my-lectures-page__filter-group">
          <span className="my-lectures-page__filter-label">
            {t('myLectures.filters.status', 'Status')}
          </span>
          <SegmentControl
            testId="my-lectures-status-filter"
            ariaLabel={t('myLectures.filters.status', 'Status')}
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
            renderLabel={(opt) => t(opt.labelKey, opt.fallback)}
          />
        </div>
        <div className="my-lectures-page__filter-group">
          <span className="my-lectures-page__filter-label">
            {t('myLectures.filters.visibility', 'Visibility')}
          </span>
          <SegmentControl
            testId="my-lectures-visibility-filter"
            ariaLabel={t('myLectures.filters.visibility', 'Visibility')}
            options={VISIBILITY_OPTIONS}
            value={visibilityFilter}
            onChange={setVisibilityFilter}
            renderLabel={(opt) => t(opt.labelKey, opt.fallback)}
          />
        </div>
        {total != null && (
          <span
            data-testid="my-lectures-total"
            className="my-lectures-page__total"
          >
            {t('myLectures.total', '{{count}} total', { count: total })}
          </span>
        )}
      </div>

      {loading && (
        <div
          data-testid="my-lectures-loading"
          className="my-lectures-page__state"
        >
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {error && !loading && (
        <div
          data-testid="my-lectures-error"
          className="my-lectures-page__state my-lectures-page__state--error"
        >
          {t(
            'myLectures.error',
            'Failed to load lectures. Please try again.',
          )}
          <button
            type="button"
            onClick={refetch}
            className="my-lectures-page__retry"
            data-testid="my-lectures-retry"
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {!loading && !error && filteredItems.length === 0 && (
        <div
          data-testid="my-lectures-empty"
          className="my-lectures-page__state"
        >
          {t(
            'myLectures.empty',
            'You don’t have any lectures yet matching the filters.',
          )}
        </div>
      )}

      {!loading && !error && filteredItems.length > 0 && (
        <ul
          className="my-lectures-page__list"
          data-testid="my-lectures-list"
        >
          {/* Шапка таблицы — на mobile скрыта (display: none). */}
          <li className="my-lectures-page__list-head" aria-hidden="true">
            <span>{t('myLectures.col.status', 'Status')}</span>
            <span>{t('myLectures.col.title', 'Title')}</span>
            <span>{t('myLectures.col.visibility', 'Visibility')}</span>
            <span>{t('myLectures.col.date', 'Date')}</span>
            <span />
          </li>

          {filteredItems.map((lecture) => {
            const isMenuOpen = openMenuId === lecture.id;
            const isBusy = busyLectureId === lecture.id;
            return (
              <li
                key={lecture.id}
                data-testid={`my-lectures-item-${lecture.id}`}
                data-status={lecture.status}
                className="my-lectures-page__item"
              >
                <span className="my-lectures-page__cell">
                  <span className={statusBadgeClass(lecture.status)}>
                    {t(
                      `lectureLanding.badge.${lecture.status}`,
                      lecture.status,
                    )}
                  </span>
                </span>
                <span className="my-lectures-page__cell">
                  <Link
                    to={`/lectures/${encodeURIComponent(lecture.id)}`}
                    className="my-lectures-page__title-link"
                    data-testid={`my-lectures-title-${lecture.id}`}
                  >
                    {lecture.title}
                  </Link>
                </span>
                <span
                  className="my-lectures-page__cell my-lectures-page__visibility"
                  data-testid={`my-lectures-visibility-${lecture.id}`}
                >
                  <span className="my-lectures-page__cell-label">
                    {t('myLectures.col.visibility', 'Visibility')}
                  </span>
                  {lecture.visibility}
                </span>
                <span
                  className="my-lectures-page__cell my-lectures-page__date"
                  data-testid={`my-lectures-date-${lecture.id}`}
                >
                  <span className="my-lectures-page__cell-label">
                    {t('myLectures.col.date', 'Date')}
                  </span>
                  {formatDate(
                    lecture.scheduledAt ?? lecture.startedAt ?? lecture.createdAt,
                  )}
                </span>
                <div className="my-lectures-page__actions">
                  <button
                    type="button"
                    aria-label={t('common.actions', 'Actions')}
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    disabled={isBusy}
                    onClick={() =>
                      setOpenMenuId(isMenuOpen ? null : lecture.id)
                    }
                    data-testid={`my-lectures-menu-${lecture.id}`}
                    className="my-lectures-page__menu-btn"
                  >
                    ⋮
                  </button>
                  {isMenuOpen && (
                    <div
                      role="menu"
                      data-testid={`my-lectures-menu-popover-${lecture.id}`}
                      className="my-lectures-page__menu-popover"
                      onMouseLeave={() => setOpenMenuId(null)}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`my-lectures-action-open-${lecture.id}`}
                        onClick={() => {
                          setOpenMenuId(null);
                          navigate(`/lectures/${encodeURIComponent(lecture.id)}`);
                        }}
                        className="my-lectures-page__menu-item"
                      >
                        {t('myLectures.actions.open', 'Open')}
                      </button>
                      {lecture.status === 'scheduled' && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid={`my-lectures-action-start-${lecture.id}`}
                          onClick={() => {
                            setOpenMenuId(null);
                            void handleStart(lecture);
                          }}
                          className="my-lectures-page__menu-item"
                        >
                          {t('myLectures.actions.start', 'Start')}
                        </button>
                      )}
                      {lecture.status === 'live' && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid={`my-lectures-action-force-end-${lecture.id}`}
                          onClick={() => {
                            setOpenMenuId(null);
                            void handleForceEnd(lecture);
                          }}
                          className="my-lectures-page__menu-item"
                        >
                          {t('myLectures.actions.forceEnd', 'End broadcast')}
                        </button>
                      )}
                      {(lecture.status === 'scheduled' ||
                        lecture.status === 'live' ||
                        lecture.status === 'recorded') && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid={`my-lectures-action-settings-${lecture.id}`}
                          onClick={() => {
                            setOpenMenuId(null);
                            setSettingsLecture(lecture);
                          }}
                          className="my-lectures-page__menu-item"
                        >
                          {t('myLectures.actions.settings', 'Settings')}
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`my-lectures-action-share-${lecture.id}`}
                        onClick={() => {
                          setOpenMenuId(null);
                          void handleShare(lecture);
                        }}
                        className="my-lectures-page__menu-item"
                      >
                        {t('myLectures.actions.share', 'Copy link')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`my-lectures-action-delete-${lecture.id}`}
                        onClick={() => {
                          setOpenMenuId(null);
                          void handleDelete(lecture);
                        }}
                        className="my-lectures-page__menu-item my-lectures-page__menu-item--danger"
                      >
                        {t('myLectures.actions.delete', 'Delete')}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && !loading && !error && (
        <div className="my-lectures-page__load-more-wrap">
          <button
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
            data-testid="my-lectures-load-more"
            className="my-lectures-page__load-more"
          >
            {loadingMore
              ? t('common.loading', 'Loading…')
              : t('myLectures.loadMore', 'Load more')}
          </button>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="my-lectures-toast"
          className="my-lectures-page__toast"
        >
          {toast}
        </div>
      )}

      {settingsLecture && (
        <LectureSettingsModal
          lectureId={settingsLecture.id}
          initialTab="tools"
          onClose={() => setSettingsLecture(null)}
          onSaved={() => {
            setSettingsLecture(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
