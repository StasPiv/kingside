import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LessonStepType, StepPayload } from '@kingside/shared';

import type { StepFixture } from '../../../types/editor';
import { emptyStepPayload } from '../../../types/editor';
import { StepRenderer } from '../StepRenderer';

import {
  EndgameDrillFields,
  GameReviewFields,
  PositionFields,
  PuzzleFields,
  QuizFields,
  TextFields,
  VideoFields,
} from './fields';

/**
 * Специализированный по `payload.type` редактор одного шага
 * (L-27 / KS-1805, KS-1849 / FE-R1).
 *
 * Редактор форму-based: все поля — `<input>`/`<textarea>`/`<select>`. Для
 * диаграмм и позиции показывается мини-доска через `MemoChessboard`
 * (read-only — редактор FEN'а через drag'n'drop — отдельная большая
 * задача, вне scope MVP).
 *
 * Предпросмотр (`StepRenderer` с тем же payload'ом, что и в проде)
 * монтируется в хвост редактора — автор сразу видит, что получится.
 *
 * # Структура файлов (KS-1849 / FE-R1)
 *
 * Конкретные формы `*Fields` вынесены в `./fields/*.tsx` (по одной
 * на каждый тип шага). `StepEditor` — композирующий контейнер:
 * header (тип + действия) → тело (форма) → preview. Публичный API
 * `StepEditor` НЕ изменился (KS-1836 регрессия проходит).
 */

/**
 * Полный список типов шага, поддерживаемых редактором (совпадает с
 * реализованными кейсами `emptyStepPayload` и соответствующими
 * `<XxxFields>`-компонентами в `./fields/`).
 *
 * `opening_drill` в этот массив не входит осознанно: для него нет
 * `emptyStepPayload`-кейса и нет формы — включать его в `<select>` =
 * ронять редактор в рантайме. Добавление поддержки — отдельная задача.
 */
const STEP_TYPES: LessonStepType[] = [
  'text',
  'puzzle',
  'quiz',
  'position',
  'game_review',
  'video',
  'endgame_drill',
];

interface StepEditorProps {
  step: StepFixture;
  onChange: (next: StepFixture) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /**
   * KS-1836 (ADR-026 §2.6): ограничение набора типов шага в `<select>`.
   * Если задан — в селекте остаются только пересечение с `STEP_TYPES`
   * (т.е. только поддерживаемые), в порядке, заданном prop'ом. Если
   * не задан — все поддерживаемые типы (backward-compatible, админский
   * `LessonEditorPage` не меняет поведение).
   */
  restrictToTypes?: LessonStepType[];
}

export function StepEditor({
  step,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  restrictToTypes,
}: StepEditorProps) {
  const { t } = useTranslation();

  const availableTypes = useMemo<LessonStepType[]>(() => {
    if (!restrictToTypes) return STEP_TYPES;
    const supported = new Set<LessonStepType>(STEP_TYPES);
    // Сохраняем порядок, заданный prop'ом, фильтруя неподдерживаемые.
    return restrictToTypes.filter((t) => supported.has(t));
  }, [restrictToTypes]);

  const updatePayload = (payload: StepPayload) => {
    onChange({ ...step, payload });
  };

  const changeType = (type: LessonStepType) => {
    onChange({ ...step, type, payload: emptyStepPayload(type) });
  };

  return (
    <div
      className="editor-step"
      data-testid={`editor-step-${step.id}`}
      data-step-type={step.type}
    >
      <header className="editor-step__header">
        <div className="editor-step__meta">
          <span className="editor-step__order">#{step.order}</span>
          <label>
            {t('editor.step.type', 'Type')}:{' '}
            <select
              value={step.type}
              onChange={(e) => changeType(e.target.value as LessonStepType)}
              data-testid={`editor-step-type-${step.id}`}
            >
              {availableTypes.map((tp) => (
                <option key={tp} value={tp}>
                  {tp}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="editor-step__actions">
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              data-testid={`editor-step-up-${step.id}`}
              title={t('editor.moveUp', 'Move up')}
            >
              ↑
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              data-testid={`editor-step-down-${step.id}`}
              title={t('editor.moveDown', 'Move down')}
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            data-testid={`editor-step-remove-${step.id}`}
            className="editor-step__remove"
          >
            {t('editor.remove', 'Remove')}
          </button>
        </div>
      </header>

      <div className="editor-step__body">
        {step.payload.type === 'text' && (
          <TextFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'puzzle' && (
          <PuzzleFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'quiz' && (
          <QuizFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'position' && (
          <PositionFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'game_review' && (
          <GameReviewFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'video' && (
          <VideoFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'endgame_drill' && (
          <EndgameDrillFields payload={step.payload} onChange={updatePayload} />
        )}
      </div>

      <StepPreview step={step} />
    </div>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────

function StepPreview({ step }: { step: StepFixture }) {
  const { t } = useTranslation();
  // Синтетический LessonStep — StepRenderer ждёт полный shape с id/lessonId.
  // Для preview'а достаточно id'ов-пустышек.
  const syntheticStep = useMemo(
    () => ({
      id: `preview-${step.id}`,
      lessonId: 'preview-lesson',
      order: step.order,
      type: step.type,
      payload: step.payload,
    }),
    [step],
  );

  return (
    <details className="editor-step__preview" data-testid={`editor-step-preview-${step.id}`}>
      <summary>{t('lessons.editor.preview', 'Preview')}</summary>
      <div className="editor-step__preview-body">
        <StepRenderer step={syntheticStep} hideNext />
      </div>
    </details>
  );
}
