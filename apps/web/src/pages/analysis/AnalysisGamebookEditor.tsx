import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GamebookNode, GamebookPayload } from '@kingside/shared';

/**
 * KS-2873 (ADR-060 §3.3 R4 FM4) — редактор gamebook-полей выбранного
 * узла + общий intro главы.
 *
 * Когда `chapter.mode === 'gamebook'` и user — owner в editor-режиме,
 * AnalysisSidebar встраивает этот компонент. UCI ключ берётся из
 * `currentMove.lan` (например `e2e4` / `e7e8q`). При смене узла форма
 * перезаполняется. Текстовые лимиты валидируются на blur (overflow →
 * срезается до 500 / 2000 симв.).
 *
 * Сохранение делегируется через `onChange(nextPayload)` в AnalysisPage,
 * который сделает studiesApi.updateChapter({gamebook}).
 */

const MAX_FIELD_LEN = 500;
const MAX_INTRO_LEN = 2000;
const MAX_NODES = 200;

export interface AnalysisGamebookEditorProps {
  /** Текущий UCI узла; null = ни одного хода не выбрано (root). */
  currentUci: string | null;
  /** Текущий payload главы. null = пусто (создаст при первом save). */
  gamebook: GamebookPayload | null;
  /** True если user может редактировать (editor + owner + mode='gamebook'). */
  editable: boolean;
  onChange: (next: GamebookPayload) => void;
}

function getNode(
  payload: GamebookPayload | null,
  uci: string,
): GamebookNode | null {
  if (!payload?.byUci) return null;
  return payload.byUci[uci] ?? null;
}

function withNode(
  payload: GamebookPayload | null,
  uci: string,
  patch: Partial<GamebookNode>,
): GamebookPayload {
  const base: GamebookPayload = payload ?? {};
  const prevByUci = base.byUci ?? {};
  const prevNode: GamebookNode = prevByUci[uci] ?? {};
  const nextNode: GamebookNode = { ...prevNode, ...patch };
  // Если все поля стали пустыми — удалим запись (чтобы не считалась
  // node'ом против лимита 200).
  const nextIsEmpty =
    !nextNode.hint && !nextNode.success && !nextNode.failure;
  const nextByUci = { ...prevByUci };
  if (nextIsEmpty) {
    delete nextByUci[uci];
  } else {
    nextByUci[uci] = nextNode;
  }
  return { ...base, byUci: nextByUci };
}

export function AnalysisGamebookEditor({
  currentUci,
  gamebook,
  editable,
  onChange,
}: AnalysisGamebookEditorProps) {
  const { t } = useTranslation();

  const nodeCount = Object.keys(gamebook?.byUci ?? {}).length;
  const atLimit = nodeCount >= MAX_NODES;

  // Local-stale-state для inputов (commit на blur, чтобы не теребить
  // API на каждый keystroke).
  const node = currentUci ? getNode(gamebook, currentUci) : null;
  const [hint, setHint] = useState(node?.hint ?? '');
  const [success, setSuccess] = useState(node?.success ?? '');
  const [failure, setFailure] = useState(node?.failure ?? '');
  const [intro, setIntro] = useState(gamebook?.intro ?? '');
  const [showIntro, setShowIntro] = useState(false);

  // При смене UCI / payload — синхронизируем локальное состояние.
  useEffect(() => {
    const n = currentUci ? getNode(gamebook, currentUci) : null;
    setHint(n?.hint ?? '');
    setSuccess(n?.success ?? '');
    setFailure(n?.failure ?? '');
    setIntro(gamebook?.intro ?? '');
  }, [currentUci, gamebook]);

  const commitNodeField = (field: 'hint' | 'success' | 'failure', value: string) => {
    if (!editable || !currentUci) return;
    const trimmed = value.slice(0, MAX_FIELD_LEN);
    const current = currentUci ? getNode(gamebook, currentUci) : null;
    if ((current?.[field] ?? '') === trimmed) return;
    // KS-2873: ноды лимит — НЕ блокируем редактирование существующей,
    // блокируем только добавление новой. Существующая нода — если
    // payload.byUci[uci] уже есть.
    if (atLimit && !current) return;
    onChange(withNode(gamebook, currentUci, { [field]: trimmed || undefined }));
  };

  const commitIntro = (value: string) => {
    if (!editable) return;
    const trimmed = value.slice(0, MAX_INTRO_LEN);
    if ((gamebook?.intro ?? '') === trimmed) return;
    onChange({ ...(gamebook ?? {}), intro: trimmed || undefined });
  };

  return (
    <div
      className="analysis-gamebook-editor"
      data-testid="analysis-gamebook-editor"
    >
      <div className="analysis-gamebook-editor__header">
        <strong>{t('studies.gamebook.title', 'Gamebook')}</strong>
        <button
          type="button"
          className="analysis-gamebook-editor__intro-btn"
          data-testid="analysis-gamebook-intro-toggle"
          onClick={() => setShowIntro((v) => !v)}
        >
          {t('studies.gamebook.intro', 'Intro')}
        </button>
        <span
          className="analysis-gamebook-editor__count"
          data-testid="analysis-gamebook-count"
          data-at-limit={atLimit ? 'true' : 'false'}
        >
          {t('studies.gamebook.nodeCount', '{{count}}/{{max}}', {
            count: nodeCount,
            max: MAX_NODES,
          })}
        </span>
      </div>

      {showIntro && (
        <div className="analysis-gamebook-editor__intro">
          <label>{t('studies.gamebook.intro', 'Intro')}</label>
          <textarea
            data-testid="analysis-gamebook-intro-input"
            value={intro}
            disabled={!editable}
            maxLength={MAX_INTRO_LEN}
            onChange={(e) => setIntro(e.target.value)}
            onBlur={(e) => commitIntro(e.target.value)}
          />
        </div>
      )}

      {!currentUci && (
        <div
          className="analysis-gamebook-editor__placeholder"
          data-testid="analysis-gamebook-placeholder"
        >
          {t(
            'studies.gamebook.selectMove',
            'Select a move to edit its hint / success / failure.',
          )}
        </div>
      )}

      {currentUci && (
        <div
          className="analysis-gamebook-editor__node"
          data-testid="analysis-gamebook-node"
          data-uci={currentUci}
        >
          <div className="analysis-gamebook-editor__uci">
            {t('studies.gamebook.uci', 'Move')}: <code>{currentUci}</code>
          </div>

          <label>{t('studies.gamebook.hint', 'Hint (before move)')}</label>
          <textarea
            data-testid="analysis-gamebook-hint-input"
            value={hint}
            disabled={!editable || (atLimit && !node)}
            maxLength={MAX_FIELD_LEN}
            onChange={(e) => setHint(e.target.value)}
            onBlur={(e) => commitNodeField('hint', e.target.value)}
          />

          <label>{t('studies.gamebook.success', 'Success (after correct)')}</label>
          <textarea
            data-testid="analysis-gamebook-success-input"
            value={success}
            disabled={!editable || (atLimit && !node)}
            maxLength={MAX_FIELD_LEN}
            onChange={(e) => setSuccess(e.target.value)}
            onBlur={(e) => commitNodeField('success', e.target.value)}
          />

          <label>{t('studies.gamebook.failure', 'Failure (after wrong)')}</label>
          <textarea
            data-testid="analysis-gamebook-failure-input"
            value={failure}
            disabled={!editable || (atLimit && !node)}
            maxLength={MAX_FIELD_LEN}
            onChange={(e) => setFailure(e.target.value)}
            onBlur={(e) => commitNodeField('failure', e.target.value)}
          />

          {atLimit && !node && (
            <div
              className="analysis-gamebook-editor__limit"
              role="status"
              data-testid="analysis-gamebook-limit-msg"
            >
              {t(
                'studies.gamebook.atLimit',
                'Node limit reached ({{max}}). Remove fields from other nodes to add new ones.',
                { max: MAX_NODES },
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
