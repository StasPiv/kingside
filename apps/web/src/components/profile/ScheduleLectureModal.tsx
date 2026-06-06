import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

/**
 * KS-3802 / ADR-113 §4 крупная задача 3. Модальное окно «Запланировать
 * лекцию» на странице тренера `/coach/:username`. Поля: title,
 * description, scheduledAt (datetime-local). На submit:
 *
 *   POST /lectures { title, description?, scheduledAt }
 *
 * без `analysisId` — scheduled-лекция без привязки к Analysis,
 * привязка появится позже когда автор откроет её и запустит. Backend
 * (KS-3784/KS-3785) возвращает `{ lecture, liveAnalysis: null }` для
 * scheduled-веток.
 */

interface ScheduledLectureSummary {
  id: string;
  title: string;
  scheduledAt: string;
}

interface CreateLectureResponse {
  lecture: ScheduledLectureSummary;
  liveAnalysis: null;
}

interface ScheduleLectureModalProps {
  onClose: () => void;
  /**
   * Колбэк успешного создания — родитель обновит секцию «Расписание»
   * (когда она появится в KS-3803). До тех пор используется чтобы
   * показать всплывающее уведомление.
   */
  onCreated: (lecture: ScheduledLectureSummary) => void;
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
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

export function ScheduleLectureModal({
  onClose,
  onCreated,
}: ScheduleLectureModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const initialScheduled = useMemo(() => defaultScheduledAtLocal(), []);
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
      const resp = await api.post<CreateLectureResponse>('/lectures', {
        title: trimmedTitle,
        ...(description.trim() ? { description: description.trim() } : {}),
        scheduledAt: parsedScheduledAt!.toISOString(),
      });
      onCreated(resp.lecture);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t(
            'lectureSchedule.create.failed',
            'Failed to schedule the lecture. Please try again.',
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
            {t('lectureSchedule.create.title', 'Schedule a lecture')}
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
              : t('lectureSchedule.create.submit', 'Schedule lecture')}
          </button>
        </div>
      </div>
    </div>
  );
}
