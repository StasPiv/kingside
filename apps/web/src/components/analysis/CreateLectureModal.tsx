import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

/**
 * KS-3789 / ADR-113 §4 эпик 1. Модальное окно «Создать новую лекцию»
 * на странице AnalysisPage автора. Запускает мгновенную live-лекцию
 * на основе уже сохранённого анализа:
 *
 *   POST /lectures { title, description, analysisId }  без scheduledAt
 *
 * Ответ backend (контракт KS-3784/KS-3785):
 *   {
 *     lecture: <Lecture>,
 *     liveAnalysis: { id, slug, url } | null
 *   }
 *
 * Поле `liveAnalysis` приходит ненулевым при immediate-live — backend
 * проходит через `LiveAnalysisService.create({ analysisId })`, в нём
 * идемпотентность по `(ownerId, analysisId)`: если у автора уже была
 * запущена обычная трансляция этого анализа, лекция будет привязана
 * к существующей сессии (slug совпадёт).
 *
 * После успеха модальное окно зовёт `onCreated(liveAnalysis)`, дальше
 * AnalysisPage сам подключает live-режим через
 * `useAnalysisLiveBroadcast.attachExistingSession` — никаких
 * дополнительных навигаций или перезагрузок не нужно.
 */

export interface CreateLectureLiveSession {
  id: string;
  slug: string;
  url: string;
}

interface CreateLectureResponse {
  lecture: { id: string; title: string };
  liveAnalysis: CreateLectureLiveSession | null;
}

interface CreateLectureModalProps {
  analysisId: string;
  /** Стартовый title — берём analysisTitle, чтобы автору не пришлось перепечатывать. */
  defaultTitle?: string;
  onClose: () => void;
  /**
   * Колбэк с сессией трансляции и id созданной лекции; вызывается до
   * закрытия модального окна. `lectureId` нужен `AnalysisPage`, чтобы
   * подключить компактный значок записи (KS-3869) без асинхронной
   * выборки по slug-у — иначе `useLectureAudioPublisher.start()` не
   * успевает запуститься до первого `MediaRecorder.ondataavailable`,
   * и чанки никуда не отправляются.
   */
  onCreated: (
    session: CreateLectureLiveSession,
    lectureId: string,
  ) => void;
}

export function CreateLectureModal({
  analysisId,
  defaultTitle,
  onClose,
  onCreated,
}: CreateLectureModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<string>(defaultTitle ?? '');
  const [description, setDescription] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * KS-3911 / ADR-117 B01. UI хранит «разрешённые» (отмеченные галочкой)
   * инструменты, чтобы дефолт совпадал с UX-ожиданием тренера: открыл
   * модалку — все галочки стоят, все доступно. На отправку инвертируем
   * в `disabledTools` через `ALL_LECTURE_DISABLED_TOOLS.filter`.
   */
  const [enabledTools, setEnabledTools] = useState<LectureDisabledTool[]>(
    () => [...ALL_LECTURE_DISABLED_TOOLS],
  );

  const toggleTool = (tool: LectureDisabledTool) => {
    setEnabledTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  const trimmedTitle = title.trim();
  const submitDisabled = submitting || trimmedTitle.length === 0;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      // KS-3911 / ADR-117 B01. UI хранит «разрешённые» инструменты;
      // backend ждёт ИНВЕРСНЫЙ список — «отключённые». Считаем как
      // разность whitelist'а и текущего набора галочек: всё что не
      // отмечено — попадает в `disabledTools`. Поле отправляем всегда,
      // даже если массив пуст (=== все инструменты разрешены), чтобы
      // backend не догадывался по отсутствию ключа.
      const disabledTools: LectureDisabledTool[] = ALL_LECTURE_DISABLED_TOOLS
        .filter((tool) => !enabledTools.includes(tool));
      const resp = await api.post<CreateLectureResponse>('/lectures', {
        title: trimmedTitle,
        // Описание опциональное; пустую строку backend не ждёт — отправляем
        // поле только если автор что-то ввёл.
        ...(description.trim() ? { description: description.trim() } : {}),
        analysisId,
        disabledTools,
      });
      if (!resp.liveAnalysis) {
        // Контракт обещает ненулевой liveAnalysis для immediate-live
        // (без scheduledAt). Защитная ветка на случай поломки контракта —
        // показываем ошибку, не молчим.
        setError(
          t(
            'lecture.create.missingLiveSession',
            'The lecture was created, but no live session was returned. Please try again.',
          ),
        );
        return;
      }
      onCreated(resp.liveAnalysis, resp.lecture.id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t('lecture.create.failed', 'Failed to start the lecture. Please try again.'),
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
        data-testid="create-lecture-modal"
      >
        <div className="modal-header">
          <h2>{t('lecture.create.title', 'Start a new lecture')}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            ×
          </button>
        </div>

        <div className="import-form">
          <div className="import-field">
            <label htmlFor="create-lecture-title">
              {t('lecture.create.fieldTitle', 'Title')}
            </label>
            <input
              id="create-lecture-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('lecture.create.titlePlaceholder', 'e.g. Caro-Kann for beginners')}
              maxLength={200}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div className="import-field">
            <label htmlFor="create-lecture-description">
              {t('lecture.create.fieldDescription', 'Description')}
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 'normal' }}>
                {t('common.optional', 'optional')}
              </span>
            </label>
            <textarea
              id="create-lecture-description"
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

          <div
            className="import-field"
            data-testid="create-lecture-tools-section"
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
                    htmlFor={`create-lecture-tool-${tool}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      fontWeight: 'normal',
                    }}
                  >
                    <input
                      id={`create-lecture-tool-${tool}`}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(tool)}
                      disabled={submitting}
                      data-testid={`create-lecture-tool-${tool}`}
                    />
                    <span>{t(`lectureTools.tools.${tool}`)}</span>
                  </label>
                );
              })}
            </div>
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
              : t('lecture.create.submit', 'Start lecture')}
          </button>
        </div>
      </div>
    </div>
  );
}
