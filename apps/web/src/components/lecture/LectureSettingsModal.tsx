import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
  type LectureSummary,
  type LectureVisibility,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';
import { useLectureDetail } from '../../hooks/useLectureDetail';
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
 * KS-3982 (ADR-119 §8 эпик E): встроенные стили заменены на
 * CSS-классы `.lecture-modal*` из `lecture.css`. На ≥640px —
 * центральная карточка, на <640px — выдвижной лист снизу с
 * ручкой-индикатором; вкладки переключаются единым стилем с
 * подсветкой активной. ARIA-роли (`tablist`/`tab`/`tabpanel`) и
 * `data-testid` сохранены.
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
  lectureId: string;
  onClose: () => void;
  /**
   * Вызывается после успешного PATCH. Родитель обновляет свой
   * локальный snapshot (например, `MyLecturesPage` делает refetch
   * списка); allowlist уже синхронизирован внутри
   * `LectureAccessPanel`.
   */
  onSaved?: (updated: LectureSummary) => void;
  /**
   * KS-3975 / ADR-119 C06. Вкладка, которая открывается первой.
   * `AnalysisActionsMenu` для пункта «Доступ учеников» передаёт
   * `'access'`; для «Настройки инструментов» — `'tools'`;
   * по умолчанию `'main'`.
   */
  initialTab?: Tab;
}

export function LectureSettingsModal({
  lectureId,
  onClose,
  onSaved,
  initialTab = 'main',
}: LectureSettingsModalProps) {
  const { t } = useTranslation();
  const tabsLabelId = useId();

  const [tab, setTab] = useState<Tab>(initialTab);

  // KS-3975 / ADR-119 C06. Полный snapshot лекции получаем сами
  // через `useLectureDetail` — родители (AnalysisPage,
  // MyLecturesPage) держат разные неполные «слепки» (`LectureSummary`
  // в shared / локальный тип в LectureReplayPage). Один источник
  // правды для form-state модалки — отдельный REST-запрос.
  const { lecture, loading, error: detailError } =
    useLectureDetail(lectureId);

  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [visibility, setVisibility] =
    useState<LectureVisibility>('public');
  const [enabledTools, setEnabledTools] =
    useState<LectureDisabledTool[]>([...ALL_LECTURE_DISABLED_TOOLS]);
  const [hydrated, setHydrated] = useState(false);

  // Когда `useLectureDetail` дотянул полный snapshot, инициализируем
  // form-state. Делаем это один раз — пользовательский ввод после
  // первой гидрации не сбрасываем (если модалка ещё открыта и
  // пришёл повторный fetch, например после refetch на сохранении —
  // полагаемся на `onSaved` + закрытие модалки).
  useEffect(() => {
    if (!lecture || hydrated) return;
    setTitle(lecture.title);
    setDescription(lecture.description ?? '');
    setVisibility(lecture.visibility);
    setEnabledTools(
      ALL_LECTURE_DISABLED_TOOLS.filter(
        (tool) => !(lecture.disabledTools ?? []).includes(tool),
      ),
    );
    setHydrated(true);
  }, [lecture, hydrated]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const submitDisabled =
    submitting || !hydrated || trimmedTitle.length === 0;

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    const disabledTools = ALL_LECTURE_DISABLED_TOOLS.filter(
      (tool) => !enabledTools.includes(tool),
    );
    try {
      const updated = await api.patch<LectureSummary>(
        `/lectures/${encodeURIComponent(lectureId)}`,
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
    <div className="lecture-modal-overlay" onClick={onClose}>
      <div
        className="lecture-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="lecture-settings-modal"
        data-active-tab={tab}
        role="dialog"
        aria-modal="true"
      >
        <header className="lecture-modal__header">
          <h2 className="lecture-modal__title">
            {t('lectureSettings.title', 'Lecture settings')}
          </h2>
          <button
            type="button"
            className="lecture-modal__close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </header>

        <div
          role="tablist"
          aria-labelledby={tabsLabelId}
          data-testid="lecture-settings-tablist"
          className="lecture-modal__tablist"
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
                className={
                  'lecture-modal__tab' +
                  (isActive ? ' lecture-modal__tab--active' : '')
                }
              >
                {t(opt.labelKey, opt.fallback)}
              </button>
            );
          })}
        </div>

        <div className="import-form">
          {loading && !hydrated && (
            <div
              data-testid="lecture-settings-loading"
              style={{ padding: 16, opacity: 0.7 }}
            >
              {t('common.loading', 'Loading…')}
            </div>
          )}
          {detailError && !hydrated && (
            <div
              className="error"
              data-testid="lecture-settings-load-error"
              style={{ padding: 8 }}
            >
              {detailError === 'forbidden'
                ? t(
                    'lectureSettings.loadForbidden',
                    'Only the lecture owner can edit settings.',
                  )
                : detailError === 'not-found'
                  ? t(
                      'lectureSettings.loadNotFound',
                      'Lecture not found.',
                    )
                  : t(
                      'lectureSettings.loadFailed',
                      'Failed to load lecture details. Please try again.',
                    )}
            </div>
          )}
          {hydrated && tab === 'main' && (
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

          {hydrated && tab === 'access' && (
            <div
              id={`${tabsLabelId}-access`}
              role="tabpanel"
              aria-labelledby={`${tabsLabelId}-access-tab`}
              data-testid="lecture-settings-panel-access"
            >
              <LectureAccessPanel
                lectureId={lectureId}
                visibility={visibility}
                onVisibilityChange={setVisibility}
                disabled={submitting || !hydrated}
              />
            </div>
          )}

          {hydrated && tab === 'tools' && (
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
