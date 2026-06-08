import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

/**
 * KS-3912 / ADR-117 §3 (шаг B02). Модальное окно «Настройки лекции
 * для учеников» — тренер открывает его из меню действий AnalysisPage
 * (`AnalysisActionsMenu`, пункт `lecture-tools-settings`).
 *
 * Содержимое окна повторяет секцию из `CreateLectureModal` (B01):
 * по одной строке-чекбоксу на каждый `LectureDisabledTool`,
 * семантика «галочка = инструмент разрешён ученикам». При клике
 * «Сохранить» отправляется `PATCH /lectures/:id { disabledTools }`
 * с инверсией от выбранных галочек. Поле уезжает всегда (даже
 * пустой массив = все инструменты разрешены), чтобы backend не
 * догадывался по отсутствию ключа.
 *
 * Поведение при ошибке (ADR-117 §UI-decisions / acceptance KS-3912):
 *  - Если `PATCH /lectures/:id` возвращает ошибку, локальное
 *    состояние галочек откатывается к `initialDisabledTools` —
 *    тренер видит исходные настройки, ничего «незаметно» не
 *    зафиксировалось. Текст ошибки рендерится внизу окна; окно
 *    остаётся открытым, тренер может попробовать ещё раз.
 *  - При успехе вызывается `onSaved(disabledTools)` (родитель
 *    обновляет свой локальный snapshot), затем `onClose()`.
 */

interface LectureToolsSettingsModalProps {
  /** UUID лекции для эндпоинта `PATCH /lectures/:id`. */
  lectureId: string;
  /**
   * Текущий список запрещённых инструментов (`Lecture.disabledTools`).
   * Источник — родитель (REST snapshot или state-обновление после
   * успешного `PATCH`). Используется как стартовое значение чекбоксов
   * и как ориентир для отката при ошибке.
   */
  initialDisabledTools: LectureDisabledTool[];
  onClose: () => void;
  /**
   * Колбэк успешного `PATCH`. Родитель обновляет свой кэш
   * `lecture.disabledTools` и при необходимости показывает
   * уведомление об успехе. Список идентичен тому, что мы только что
   * отправили — backend по контракту KS-3900 принимает значение как
   * есть.
   */
  onSaved?: (disabledTools: LectureDisabledTool[]) => void;
}

export function LectureToolsSettingsModal({
  lectureId,
  initialDisabledTools,
  onClose,
  onSaved,
}: LectureToolsSettingsModalProps) {
  const { t } = useTranslation();

  // UI хранит «разрешённые» галочки — инверсию от `disabledTools`,
  // чтобы дефолт совпадал с UX-ожиданием тренера: галочка стоит =
  // инструмент доступен. Считаем initial-инверсию через filter.
  const computeInitialEnabled = (
    disabled: LectureDisabledTool[],
  ): LectureDisabledTool[] =>
    ALL_LECTURE_DISABLED_TOOLS.filter((tool) => !disabled.includes(tool));

  const [enabledTools, setEnabledTools] = useState<LectureDisabledTool[]>(
    () => computeInitialEnabled(initialDisabledTools),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTool = (tool: LectureDisabledTool) => {
    setEnabledTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const disabledTools: LectureDisabledTool[] = ALL_LECTURE_DISABLED_TOOLS
      .filter((tool) => !enabledTools.includes(tool));
    try {
      await api.patch(`/lectures/${encodeURIComponent(lectureId)}`, {
        disabledTools,
      });
      onSaved?.(disabledTools);
      onClose();
    } catch (e) {
      // KS-3912 acceptance: ошибка PATCH откатывает локальное
      // состояние — возвращаем чекбоксы к исходному набору, чтобы
      // тренер не оставался с «как будто сохранёнными» правками.
      setEnabledTools(computeInitialEnabled(initialDisabledTools));
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t(
            'lectureTools.saveError',
            'Failed to save settings. Please try again.',
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
        data-testid="lecture-tools-settings-modal"
      >
        <div className="modal-header">
          <h2>
            {t('lectureTools.modalTitle', 'Lecture settings for students')}
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
          <div
            className="import-field"
            data-testid="lecture-tools-settings-section"
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
                    htmlFor={`lecture-tools-settings-${tool}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      fontWeight: 'normal',
                    }}
                  >
                    <input
                      id={`lecture-tools-settings-${tool}`}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(tool)}
                      disabled={submitting}
                      data-testid={`lecture-tools-settings-${tool}`}
                    />
                    <span>{t(`lectureTools.tools.${tool}`)}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {error && (
            <div
              className="error"
              style={{ marginTop: 8 }}
              data-testid="lecture-tools-settings-error"
            >
              {error}
            </div>
          )}

          <button
            className="import-btn"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            data-testid="lecture-tools-settings-save"
            style={{ marginTop: 12 }}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('lectureTools.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
