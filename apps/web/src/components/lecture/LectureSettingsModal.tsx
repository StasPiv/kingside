import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
  type LectureSummary,
  type LectureVisibility,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';
import { LectureAccessPanel } from './LectureAccessPanel';

/**
 * KS-3974 / ADR-119 §8 эпик C (C05). Модальное окно настроек
 * лекции с тремя вкладками — Основное / Доступ / Инструменты.
 *
 *  - «Основное» (`main`)   — название и описание лекции.
 *  - «Доступ» (`access`)   — `LectureAccessPanel` (KS-3972) с
 *    радио visibility и allowlist'ом. Изменения allowlist'а
 *    применяются мгновенно через `useLectureAccess` (его
 *    оптимистические POST/DELETE). Радио visibility и поля из
 *    «Основного» / «Инструментов» уходят одним PATCH'ем по
 *    нажатию «Сохранить».
 *  - «Инструменты» (`tools`) — чекбоксы из `lectureTools.tools`
 *    (UI совпадает с `LectureToolsSettingsModal` KS-3912).
 *
 * Контракт:
 *  - `lecture` — начальный snapshot, источник для form-state.
 *  - `onSaved(updated)` — родитель получает обновлённый
 *    snapshot. На дальнейшее обновление allowlist'а
 *    подписываться не нужно: `LectureAccessPanel` сам управляет
 *    своим состоянием.
 *
 * Layout (KS-3982) подключит вкладки и sliding-sheet на mobile;
 * inline-стили здесь — функциональный уровень. Все ключевые
 * элементы помечены `data-testid` для тестов и стилизации.
 */

type Tab = 'main' | 'access' | 'tools';

const TABS: ReadonlyArray<{
  value: Tab;
  labelKey: string;
  fallback: string;
}> = [
  { value: 'main', labelKey: 'lectureSettings.tabs.main', fallback: 'General' },
  { value: 'access', labelKey: 'lectureSettings.tabs.access', fallback: 'Access' },
  { value: 'tools', labelKey: 'lectureSettings.tabs.tools', fallback: 'Tools' },
];

interface LectureSettingsModalProps {
  lecture: LectureSummary;
  onClose: () => void;
  /**
   * Вызывается после успешного PATCH. Родитель обновляет свой
   * локальный snapshot (например, `MyLecturesPage` делает refetch
   * списка); allowlist уже синхронизирован внутри
   * `LectureAccessPanel`.
   */
  onSaved?: (updated: LectureSummary) => void;
}

export function LectureSettingsModal({
  lecture,
  onClose,
  onSaved,
}: LectureSettingsModalProps) {
  const { t } = useTranslation();
  const tabsLabelId = useId();

  const [tab, setTab] = useState<Tab>('main');

  const [title, setTitle] = useState<string>(lecture.title);
  const [description, setDescription] = useState<string>(
    lecture.description ?? '',
  );
  const [visibility, setVisibility] = useState<LectureVisibility>(
    lecture.visibility,
  );
  // UI хранит «разрешённые» инструменты (галочка = разрешено).
  // Конвертация в backend-формат `disabledTools` происходит при
  // отправке PATCH'а — единый источник правды между этой модалкой
  // и `LectureToolsSettingsModal` (KS-3912) / `CreateLectureModal`
  // (KS-3911).
  const initialEnabled = ALL_LECTURE_DISABLED_TOOLS.filter(
    (tool) => !(lecture.disabledTools ?? []).includes(tool),
  );
  const [enabledTools, setEnabledTools] =
    useState<LectureDisabledTool[]>(initialEnabled);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const submitDisabled = submitting || trimmedTitle.length === 0;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    const disabledTools = ALL_LECTURE_DISABLED_TOOLS.filter(
      (tool) => !enabledTools.includes(tool),
    );
    try {
      const updated = await api.patch<LectureSummary>(
        `/lectures/${encodeURIComponent(lecture.id)}`,
        {
          title: trimmedTitle,
          description: description.trim() ? description.trim() : null,
          visibility,
          disabledTools,
        },
      );
      onSaved?.(updated);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t(
            'lectureSettings.saveError',
            'Failed to save settings. Please try again.',
          ),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTool = (tool: LectureDisabledTool) => {
    setEnabledTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
        data-testid="lecture-settings-modal"
        data-active-tab={tab}
      >
        <div className="modal-header">
          <h2>{t('lectureSettings.title', 'Lecture settings')}</h2>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </div>

        <div
          role="tablist"
          aria-labelledby={tabsLabelId}
          data-testid="lecture-settings-tablist"
          style={{
            display: 'flex',
            gap: 4,
            borderBottom: '1px solid #e5e7eb',
            marginBottom: 16,
          }}
        >
          {TABS.map((opt) => {
            const isActive = tab === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`${tabsLabelId}-${opt.value}`}
                id={`${tabsLabelId}-${opt.value}-tab`}
                data-testid={`lecture-settings-tab-${opt.value}`}
                onClick={() => setTab(opt.value)}
                style={{
                  padding: '8px 14px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: isActive
                    ? '2px solid #1976d2'
                    : '2px solid transparent',
                  color: isActive ? '#1976d2' : 'inherit',
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                {t(opt.labelKey, opt.fallback)}
              </button>
            );
          })}
        </div>

        <div className="import-form">
          {tab === 'main' && (
            <div
              id={`${tabsLabelId}-main`}
              role="tabpanel"
              aria-labelledby={`${tabsLabelId}-main-tab`}
              data-testid="lecture-settings-panel-main"
            >
              <div className="import-field">
                <label htmlFor="lecture-settings-title">
                  {t('lecture.create.fieldTitle', 'Title')}
                </label>
                <input
                  id="lecture-settings-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  disabled={submitting}
                  data-testid="lecture-settings-title-input"
                />
              </div>
              <div className="import-field">
                <label htmlFor="lecture-settings-description">
                  {t('lecture.create.fieldDescription', 'Description')}
                  <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 'normal' }}>
                    {t('common.optional', 'optional')}
                  </span>
                </label>
                <textarea
                  id="lecture-settings-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  disabled={submitting}
                  style={{ resize: 'vertical', minHeight: 80 }}
                  data-testid="lecture-settings-description-input"
                />
              </div>
            </div>
          )}

          {tab === 'access' && (
            <div
              id={`${tabsLabelId}-access`}
              role="tabpanel"
              aria-labelledby={`${tabsLabelId}-access-tab`}
              data-testid="lecture-settings-panel-access"
            >
              <LectureAccessPanel
                lectureId={lecture.id}
                visibility={visibility}
                onVisibilityChange={setVisibility}
                disabled={submitting}
              />
            </div>
          )}

          {tab === 'tools' && (
            <div
              id={`${tabsLabelId}-tools`}
              role="tabpanel"
              aria-labelledby={`${tabsLabelId}-tools-tab`}
              data-testid="lecture-settings-panel-tools"
            >
              <label style={{ marginBottom: 6, fontWeight: 600 }}>
                {t('lectureTools.sectionTitle', 'Student tools access')}
              </label>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {ALL_LECTURE_DISABLED_TOOLS.map((tool) => {
                  const checked = enabledTools.includes(tool);
                  return (
                    <label
                      key={tool}
                      htmlFor={`lecture-settings-tool-${tool}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        fontWeight: 'normal',
                      }}
                    >
                      <input
                        id={`lecture-settings-tool-${tool}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTool(tool)}
                        disabled={submitting}
                        data-testid={`lecture-settings-tool-${tool}`}
                      />
                      <span>{t(`lectureTools.tools.${tool}`)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <div
              className="error"
              data-testid="lecture-settings-error"
              style={{ marginTop: 8 }}
            >
              {error}
            </div>
          )}

          <button
            className="import-btn"
            onClick={() => void handleSubmit()}
            disabled={submitDisabled}
            data-testid="lecture-settings-save"
            style={{ marginTop: 16 }}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('lectureSettings.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
