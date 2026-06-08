import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
  type LectureVisibility,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';
import { LectureAccessPanel } from '../lecture/LectureAccessPanel';
import type { UserSearchItem } from '../../hooks/useUserSearch';

/**
 * KS-3802 / KS-3803 / ADR-113 §4 крупная задача 3 + KS-3995 /
 * ADR-119 §7. Модальное окно «Запланировать лекцию» (`create`) или
 * «Изменить лекцию» (`edit`).
 *
 *  - `create` (без `initial`) делает
 *      POST /lectures { title, description?, scheduledAt,
 *                       visibility, disabledTools }
 *    без `analysisId`. Backend (KS-3784/85) создаёт лекцию в
 *    `status='scheduled'` и возвращает
 *    `{ lecture, liveAnalysis: null }`.
 *  - `edit` (с `initial`) делает
 *      PATCH /lectures/:id { title?, description?, scheduledAt? }
 *    по контракту KS-3800. Allowed только для `status='scheduled'`.
 *
 * KS-3995. В режиме `create` теперь доступны те же поля, что в
 * `CreateLectureModal` (KS-3911/3973): visibility через
 * `LectureAccessPanel` (compact, без allowlist'а — лекция ещё не
 * создана) и чекбоксы «Доступ учеников к инструментам». В режиме
 * `edit` оба блока скрыты — для изменения visibility/инструментов
 * у уже созданной лекции тренер использует `LectureSettingsModal`
 * (KS-3974).
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

  // KS-3995. visibility и disabledTools поля видимы только в
  // create-режиме. В edit-режиме источник этих полей — отдельная
  // модалка `LectureSettingsModal` (KS-3974), чтобы не дублировать
  // правки в двух местах.
  const [visibility, setVisibility] =
    useState<LectureVisibility>('public');
  const [enabledTools, setEnabledTools] = useState<LectureDisabledTool[]>(
    () => [...ALL_LECTURE_DISABLED_TOOLS],
  );
  // KS-3997 / KS-3934. Локальный буфер выбранных учеников до
  // создания scheduled-лекции. При смене visibility на public/
  // unlisted очищается, чтобы случайно не отправились лишние ids.
  const [pendingUsers, setPendingUsers] = useState<UserSearchItem[]>([]);
  useEffect(() => {
    if (visibility !== 'restricted' && pendingUsers.length > 0) {
      setPendingUsers([]);
    }
  }, [visibility, pendingUsers.length]);
  const toggleTool = (tool: LectureDisabledTool) => {
    setEnabledTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

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
        // KS-3995. На создание шлём полный набор полей, как у
        // `CreateLectureModal`: visibility и disabledTools здесь
        // тоже задаются. UI хранит «разрешённые» инструменты —
        // backend ждёт инверсию.
        const disabledTools: LectureDisabledTool[] =
          ALL_LECTURE_DISABLED_TOOLS.filter(
            (tool) => !enabledTools.includes(tool),
          );
        const resp = await api.post<CreateLectureResponse>('/lectures', {
          title: trimmedTitle,
          ...(description.trim() ? { description: description.trim() } : {}),
          scheduledAt: parsedScheduledAt!.toISOString(),
          visibility,
          disabledTools,
          // KS-3997 / KS-3934. При restricted шлём выбранных
          // учеников одним списком — backend bulk-INSERT'ит их в
          // `lecture_access_grants`. На public/unlisted поле
          // отсутствует.
          ...(visibility === 'restricted' && pendingUsers.length > 0
            ? { initialAccessUserIds: pendingUsers.map((u) => u.id) }
            : {}),
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
              data-testid="schedule-lecture-scheduled-at-input"
            />
          </div>

          {/* KS-3995. В create-режиме показываем secции tools/access
              чтобы тренер с одной формой задал всё нужное. В edit —
              эти блоки скрыты: для них есть отдельная модалка
              `LectureSettingsModal`. */}
          {!isEdit && (
            <>
              <div
                className="import-field"
                data-testid="schedule-lecture-tools-section"
              >
                <label style={{ marginBottom: 6 }}>
                  {t('lectureTools.sectionTitle', 'Student tools access')}
                </label>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {ALL_LECTURE_DISABLED_TOOLS.map((tool) => {
                    const checked = enabledTools.includes(tool);
                    return (
                      <label
                        key={tool}
                        htmlFor={`schedule-lecture-tool-${tool}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          cursor: submitting ? 'not-allowed' : 'pointer',
                          fontWeight: 'normal',
                        }}
                      >
                        <input
                          id={`schedule-lecture-tool-${tool}`}
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(tool)}
                          disabled={submitting}
                          data-testid={`schedule-lecture-tool-${tool}`}
                        />
                        <span>{t(`lectureTools.tools.${tool}`)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div
                className="import-field"
                data-testid="schedule-lecture-access-section"
              >
                <LectureAccessPanel
                  lectureId={null}
                  visibility={visibility}
                  onVisibilityChange={setVisibility}
                  disabled={submitting}
                  pendingUsers={pendingUsers}
                  onPendingUsersChange={setPendingUsers}
                />
              </div>
            </>
          )}

          {error && (
            <div className="error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}

          <button
            className="import-btn"
            onClick={() => void handleSubmit()}
            disabled={submitDisabled}
            data-testid="schedule-lecture-submit"
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
