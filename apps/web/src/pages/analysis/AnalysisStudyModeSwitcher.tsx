import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { StudyChapterMode } from '../../api/studiesApi';

/**
 * KS-2870 (ADR-060 §3.3 FM1) — переключатель режима главы студии.
 *
 * Отображается в AnalysisHeader только когда `ctx.kind === 'study'`
 * (editor или read-only). Owner видит dropdown'ы; non-owner — текстовый
 * индикатор.
 *
 * Состав:
 *  - dropdown «Режим»: analysis / practice / conceal / gamebook;
 *  - inline-input «Скрыть после хода №…» (когда mode='conceal');
 *  - кнопка «Редактировать сценарий» (когда mode='gamebook') — открывает
 *    gamebook editor (FM4-ticket).
 *
 * Логика «применить смену» делегируется в AnalysisPage через
 * `onChapterModeChange` (он сделает `studiesApi.updateChapter`).
 * `onConcealPlyChange` — для inline-input.
 */

const ALL_MODES: ReadonlyArray<StudyChapterMode> = [
  'analysis',
  'practice',
  'conceal',
  'gamebook',
];

export interface AnalysisStudyModeSwitcherProps {
  chapterMode: StudyChapterMode;
  /** Текущий ply для conceal-режима. Игнорируется для других режимов. */
  concealPly: number | null;
  /**
   * Когда true: dropdown disabled, inline-input disabled, кнопка
   * gamebook-edit disabled. Используется для read-only viewer'ов
   * (public-readonly, не-owner, embed).
   */
  readOnly?: boolean;
  onChapterModeChange: (mode: StudyChapterMode) => void;
  onConcealPlyChange: (ply: number) => void;
  onEditGamebook?: () => void;
  /**
   * KS-2909: handler удаления главы. Когда задан — рисуется кнопка
   * «Delete chapter». Не рисуется в read-only режиме или если prop
   * не передан (для viewer'а/contributor'а удаление недоступно).
   */
  onDeleteChapter?: () => void;
}

export function AnalysisStudyModeSwitcher({
  chapterMode,
  concealPly,
  readOnly = false,
  onChapterModeChange,
  onConcealPlyChange,
  onEditGamebook,
  onDeleteChapter,
}: AnalysisStudyModeSwitcherProps) {
  const { t } = useTranslation();
  const [concealDraft, setConcealDraft] = useState<string>(
    concealPly == null ? '' : String(concealPly),
  );

  const handleSelectMode = (next: StudyChapterMode) => {
    if (readOnly || next === chapterMode) return;
    onChapterModeChange(next);
  };

  const handleConcealCommit = () => {
    if (readOnly) return;
    const parsed = parseInt(concealDraft, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      onConcealPlyChange(parsed);
    }
  };

  return (
    <div
      className="analysis-study-mode-switcher"
      data-testid="analysis-study-mode-switcher"
    >
      <label className="analysis-study-mode-switcher__label">
        {t('studies.mode.label', 'Mode')}:
      </label>
      <select
        className="analysis-study-mode-switcher__select"
        data-testid="analysis-study-mode-select"
        value={chapterMode}
        onChange={(e) => handleSelectMode(e.target.value as StudyChapterMode)}
        disabled={readOnly}
      >
        {ALL_MODES.map((m) => (
          <option key={m} value={m}>
            {t(`studies.mode.${m}`, m)}
          </option>
        ))}
      </select>

      {chapterMode === 'conceal' && (
        <span
          className="analysis-study-mode-switcher__conceal"
          data-testid="analysis-study-mode-conceal"
        >
          <label className="analysis-study-mode-switcher__label">
            {t('studies.mode.concealAfterPly', 'Hide after move #')}:
          </label>
          <input
            type="number"
            min={1}
            className="analysis-study-mode-switcher__conceal-input"
            data-testid="analysis-study-mode-conceal-input"
            value={concealDraft}
            disabled={readOnly}
            onChange={(e) => setConcealDraft(e.target.value)}
            onBlur={handleConcealCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConcealCommit();
              }
            }}
          />
        </span>
      )}

      {chapterMode === 'gamebook' && onEditGamebook && (
        <button
          type="button"
          className="analysis-study-mode-switcher__edit-gamebook"
          data-testid="analysis-study-mode-edit-gamebook"
          onClick={onEditGamebook}
          disabled={readOnly}
        >
          {t('studies.mode.editGamebook', 'Edit script')}
        </button>
      )}

      {/* KS-2909: Delete chapter — owner-only (родитель не передаёт
          handler для viewer'а / contributor'а). На read-only тоже скрыт
          — там удаление не имеет смысла. */}
      {onDeleteChapter && !readOnly && (
        <button
          type="button"
          className="analysis-study-mode-switcher__delete"
          data-testid="analysis-study-mode-delete-chapter"
          onClick={onDeleteChapter}
          title={t('studies.action.deleteChapter', 'Delete chapter')}
        >
          {t('studies.action.deleteChapter', 'Delete chapter')}
        </button>
      )}
    </div>
  );
}
