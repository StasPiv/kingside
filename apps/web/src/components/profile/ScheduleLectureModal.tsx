import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

/**
 * KS-3802 / KS-3803 / ADR-113 §4 крупная задача 3. Модальное окно
 * «Запланировать лекцию» (`create`) или «Изменить лекцию» (`edit`).
 *
 *  - `create` (без `initial`) делает POST /lectures { title,
 *    description?, scheduledAt } без `analysisId`. Backend (KS-3784/85)
 *    создаёт лекцию в `status='scheduled'` и возвращает
 *    `{ lecture, liveAnalysis: null }`.
 *  - `edit` (с `initial`) делает PATCH /lectures/:id { title?,
 *    description?, scheduledAt? } по контракту KS-3800. Allowed только
 *    для `status='scheduled'` — backend сам отобьёт ошибкой если
 *    лекция уже ушла в live/recorded.
 */

export interface ScheduledLectureSummary {
  id: string;
  title: string;
  description?: string | null;
  scheduledAt: string;
}

interface CreateLectureResponse {
  lecture: ScheduledLectureSummary;
  liveAnalysis: null;
}

interface ScheduleLectureModalProps {
  onClose: () => void;
  /** Колбэк успешного завершения операции (create или edit). */
  onSaved: (lecture: ScheduledLectureSummary) => void;
  /**
   * Существующая лекция — переключает форму в режим редактирования
   * (PATCH /lectures/:id). Без этого параметра — режим создания.
   */
  initial?: ScheduledLectureSummary;
}

/**
 * Текущее локальное время в формате, который понимает
 * `<input type="datetime-local">` — `YYYY-MM-DDTHH:mm`. По умолчанию
 * — «сейчас плюс час», чтобы автору не пришлось целиком набирать
 * datetime вручную и чтобы дата по умолчанию была валидной (в
 * будущем).
 */
function defaultScheduledAtLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 60);
  return toDatetimeLocal(now);
}

/** ISO-строка → формат `<input type="datetime-local">` в локальной TZ. */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function ScheduleLectureModal({
  onClose,
  onSaved,
  initial,
}: ScheduleLectureModalProps) {
  const { t } = useTranslation();
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const initialScheduled = useMemo(() => {
    if (initial?.scheduledAt) {
      const d = new Date(initial.scheduledAt);
      if (!Number.isNaN(d.getTime())) return toDatetimeLocal(d);
    }
    return defaultScheduledAtLocal();
  }, [initial?.scheduledAt]);
  const [scheduledAtLocal, setScheduledAtLocal] = useState(initialScheduled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const parsedScheduledAt = scheduledAtLocal
    ? new Date(scheduledAtLocal)
    : null;
  const scheduledAtValid =
    !!parsedScheduledAt && !Number.isNaN(parsedScheduledAt.getTime());
  const submitDisabled =
    submitting || trimmedTitle.length === 0 || !scheduledAtValid;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit && initial) {
        // PATCH: отправляем только поля, которые автор реально мог
        // изменить. scheduledAt всегда — даже если совпадает с
        // прежним; backend хранит ISO и сам обработает идентичный
        // апдейт.
        const resp = await api.patch<ScheduledLectureSummary>(
          `/lectures/${encodeURIComponent(initial.id)}`,
          {
            title: trimmedTitle,
            description: description.trim() || null,
            scheduledAt: parsedScheduledAt!.toISOString(),
          },
        );
        onSaved(resp);
      } else {
        const resp = await api.post<CreateLectureResponse>('/lectures', {
          title: trimmedTitle,
          ...(description.trim() ? { description: description.trim() } : {}),
          scheduledAt: parsedScheduledAt!.toISOString(),
        });
        onSaved(resp.lecture);
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t(
            isEdit
              ? 'lectureSchedule.edit.failed'
              : 'lectureSchedule.create.failed',
            isEdit
              ? 'Failed to save changes. Please try again.'
              : 'Failed to schedule the lecture. Please try again.',
          ),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
        data-testid="schedule-lecture-modal"
      >
        <div className="modal-header">
          <h2>
            {isEdit
              ? t('lectureSchedule.edit.title', 'Edit scheduled lecture')
              : t('lectureSchedule.create.title', 'Schedule a lecture')}
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </div>

        <div className="import-form">
          <div className="import-field">
            <label htmlFor="schedule-lecture-title">
              {t('lecture.create.fieldTitle', 'Title')}
            </label>
            <input
              id="schedule-lecture-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t(
                'lecture.create.titlePlaceholder',
                'e.g. Caro-Kann for beginners',
              )}
              maxLength={200}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div className="import-field">
            <label htmlFor="schedule-lecture-description">
              {t('lecture.create.fieldDescription', 'Description')}
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 'normal' }}>
                {t('common.optional', 'optional')}
              </span>
            </label>
            <textarea
              id="schedule-lecture-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(
                'lecture.create.descriptionPlaceholder',
                'Short summary visible to viewers.',
              )}
              rows={4}
              maxLength={2000}
              disabled={submitting}
              style={{ resize: 'vertical', minHeight: 80 }}
            />
          </div>

          <div className="import-field">
            <label htmlFor="schedule-lecture-scheduled-at">
              {t('lectureSchedule.create.fieldScheduledAt', 'Start time')}
            </label>
            <input
              id="schedule-lecture-scheduled-at"
              type="datetime-local"
              value={scheduledAtLocal}
              onChange={(e) => setScheduledAtLocal(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}

          <button
            className="import-btn"
            onClick={() => void handleSubmit()}
            disabled={submitDisabled}
            style={{ marginTop: 12 }}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : isEdit
                ? t('lectureSchedule.edit.submit', 'Save changes')
                : t('lectureSchedule.create.submit', 'Schedule lecture')}
          </button>
        </div>
      </div>
    </div>
  );
}
