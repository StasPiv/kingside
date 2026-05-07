import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StepPayload, TextDiagram } from '@kingside/shared';

import { MarkdownTextEditor } from './MarkdownTextEditor';
import { SetPositionModal } from '../../../SetPositionModal';
import { DiagramEditor } from '../shared/DiagramEditor';

/**
 * `TextFields` — форма редактирования `TextStepPayload` (markdown + diagrams).
 *
 * Вынесено из inline-варианта в `StepEditor.tsx` (KS-1849 / FE-R1).
 * Публичный API `StepEditor` не меняется — это просто разделение файлов
 * чтобы новые user-course-поля могли переиспользовать / ограничивать
 * состав в FE-R4/R5, не распухая StepEditor.tsx до 1500+ строк.
 *
 * # WYSIWYG для тела (KS-1874)
 *
 * Markdown-тело лекции редактируется через `<MarkdownTextEditor>` —
 * собственный лёгкий toolbar поверх textarea. Это сохраняет контракт:
 * `payload.bodyMarkdown` — строка markdown, плейсхолдеры
 * `{{diagram:N}}` и fenced ```` ```fen ```` блоки в textarea — обычный
 * текст, никакого экранирования и трансформаций.
 *
 * # Автовставка {{diagram:N}} (KS-1827 bugfix)
 *
 * При клике «+ Добавить диаграмму» `{{diagram:N}}`-маркер
 * автоматически дописывается в конец `bodyMarkdown`. `TextStep`
 * рендерит диаграмму только если на неё есть ссылка из markdown либо
 * fenced-block — без автовставки юзер-редактора сохранял «невидимую»
 * диаграмму. Автор может свободно передвинуть маркер в теле md.
 *
 * # Board Editor для FEN (KS-1875)
 *
 * Каждая диаграмма имеет рядом с FEN-инпутом кнопку «Edit on board» —
 * она открывает `<SetPositionModal>` (продвинутый редактор позиций со
 * spec-режимом + paste-FEN). `<DiagramEditor>` (KS-2571) тоже умеет
 * двигать фигуры, но не умеет paste/copy FEN-строкой целиком —
 * `SetPositionModal` остаётся как «advanced» инструмент.
 *
 * # Визуальный редактор (KS-2572)
 *
 * Каждая диаграмма собрана в collapsible-карточку:
 *   - заголовок: «Диаграмма N» + плейсхолдер `{{diagram:N}}` + кнопки
 *     reorder (↑/↓) / duplicate / delete / collapse;
 *   - тело: `<DiagramEditor>` (KS-2571) с visual board-edit + drawing
 *     (стрелки, highlights), затем FEN-input + «Edit on board».
 *
 * Reorder реализован простыми кнопками ↑/↓ (без `@dnd-kit` — задача
 * допускает отложить drag-handle). Удаление диаграммы НЕ трогает
 * `bodyMarkdown` — плейсхолдеры остаются, и под списком показываем
 * warning со списком «битых» индексов, чтобы автор сам их подчистил.
 */

interface TextFieldsProps {
  payload: Extract<StepPayload, { type: 'text' }>;
  onChange: (p: StepPayload) => void;
}

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const DIAGRAM_PLACEHOLDER_RE = /\{\{diagram:(\d+)\}\}/g;

function makeDefaultDiagram(): TextDiagram {
  return {
    fen: STARTING_FEN,
    caption: '',
    orientation: 'white',
    arrows: [],
    highlightedSquares: [],
  };
}

/** Все индексы плейсхолдеров `{{diagram:N}}`, встретившиеся в md. */
function collectPlaceholderIndices(md: string | undefined): number[] {
  if (!md) return [];
  const seen = new Set<number>();
  for (const match of md.matchAll(DIAGRAM_PLACEHOLDER_RE)) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n)) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

export function TextFields({ payload, onChange }: TextFieldsProps) {
  const { t } = useTranslation();
  const diagrams = payload.diagrams ?? [];
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  // Collapse-состояние по индексу. Default: open для первой (для
  // быстрой работы), остальные closed чтобы не распухать вертикально.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const updateDiagramFen = (idx: number, fen: string) => {
    const next = diagrams.slice();
    if (!next[idx]) return;
    next[idx] = { ...next[idx], fen };
    onChange({ ...payload, diagrams: next });
  };

  const updateDiagram = (idx: number, patch: Partial<TextDiagram>) => {
    const next = diagrams.slice();
    if (!next[idx]) return;
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...payload, diagrams: next });
  };

  const removeDiagram = (idx: number) => {
    const next = diagrams.slice();
    next.splice(idx, 1);
    onChange({ ...payload, diagrams: next });
  };

  const duplicateDiagram = (idx: number) => {
    const next = diagrams.slice();
    const src = next[idx];
    if (!src) return;
    // Глубокая копия arrows/highlights — массивы примитивов/объектов,
    // достаточно map.
    const copy: TextDiagram = {
      ...src,
      arrows: (src.arrows ?? []).map((a) => ({ ...a })),
      highlightedSquares: (src.highlightedSquares ?? []).map((h) => ({
        ...h,
      })),
    };
    next.splice(idx + 1, 0, copy);
    onChange({ ...payload, diagrams: next });
  };

  const moveDiagram = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= diagrams.length) return;
    const next = diagrams.slice();
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item);
    onChange({ ...payload, diagrams: next });
  };

  const toggleCollapsed = (idx: number) => {
    setCollapsed((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const orphanIndices = useMemo(() => {
    const placeholders = collectPlaceholderIndices(payload.bodyMarkdown);
    return placeholders.filter((n) => n >= diagrams.length || n < 0);
  }, [payload.bodyMarkdown, diagrams.length]);

  // KS-2575: предупреждение «диаграмма существует, но нигде в md не
  // используется» — обратная ситуация по сравнению с orphan'ом
  // (placeholder есть, диаграммы нет).
  const unusedIndices = useMemo(() => {
    const placeholders = new Set(
      collectPlaceholderIndices(payload.bodyMarkdown),
    );
    const result: number[] = [];
    for (let i = 0; i < diagrams.length; i++) {
      if (!placeholders.has(i)) result.push(i);
    }
    return result;
  }, [payload.bodyMarkdown, diagrams.length]);

  return (
    <div className="editor-step__fields">
      <div className="editor-step__body">
        <span className="editor-step__body-label">
          {t('editor.step.text.body', 'Markdown body')}
        </span>
        <MarkdownTextEditor
          value={payload.bodyMarkdown ?? ''}
          onChange={(v) => onChange({ ...payload, bodyMarkdown: v })}
          minRows={20}
        />
      </div>
      <div className="editor-diagrams">
        <h4>
          {t('lessons.my.editor.text.diagrams.title', 'Diagrams')}
        </h4>
        <p className="editor-step__hint" data-testid="editor-diagrams-hint">
          {t('lessons.my.editor.text.diagrams.placeholderHint', {
            defaultValue:
              'Use {{placeholder}} placeholder in text to display.',
            placeholder: '{{diagram:N}}',
          })}
        </p>
        {unusedIndices.length > 0 && (
          <div
            className="editor-diagrams__unused-warning"
            role="status"
            data-testid="editor-diagrams-unused-warning"
          >
            {unusedIndices.map((n) => (
              <p key={n} data-testid={`editor-diagrams-unused-${n}`}>
                {t('lessons.my.editor.text.diagrams.unusedWarning', {
                  defaultValue:
                    'Diagram {{n}} is not referenced in text',
                  n: n + 1,
                })}
              </p>
            ))}
          </div>
        )}

        {orphanIndices.length > 0 && (
          <p
            className="editor-diagrams__warning"
            role="status"
            data-testid="editor-diagrams-orphan-warning"
          >
            {t('editor.step.text.orphanWarning', {
              defaultValue:
                'Markdown references missing diagram(s): {{indices}}. Remove the placeholder(s) or add the diagram(s).',
              indices: orphanIndices
                .map((n) => `{{diagram:${n}}}`)
                .join(', '),
            })}
          </p>
        )}

        {diagrams.map((d, i) => {
          const isCollapsed = collapsed[i] === true;
          return (
            <div
              key={i}
              className={`editor-diagram${isCollapsed ? ' editor-diagram--collapsed' : ''}`}
              data-testid={`editor-diagram-card-${i}`}
            >
              <div className="editor-diagram__header">
                <button
                  type="button"
                  className="editor-diagram__toggle"
                  onClick={() => toggleCollapsed(i)}
                  data-testid={`editor-diagram-toggle-${i}`}
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed
                      ? t('editor.step.text.expand', 'Expand')
                      : t('editor.step.text.collapse', 'Collapse')
                  }
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <span className="editor-diagram__title">
                  {t('lessons.my.editor.text.diagrams.itemTitle', {
                    defaultValue: 'Diagram {{n}}',
                    n: i + 1,
                  })}
                </span>
                <code
                  className="editor-diagram__ref"
                  data-testid={`editor-diagram-ref-${i}`}
                  title={t(
                    'editor.step.text.diagramRefHint',
                    'Paste this marker into the markdown where the diagram should appear.',
                  )}
                >{`{{diagram:${i}}}`}</code>
                <span className="editor-diagram__spacer" />
                <button
                  type="button"
                  className="editor-diagram__icon-btn"
                  onClick={() => moveDiagram(i, -1)}
                  disabled={i === 0}
                  data-testid={`editor-diagram-move-up-${i}`}
                  aria-label={t('editor.step.text.moveUp', 'Move up')}
                  title={t('editor.step.text.moveUp', 'Move up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="editor-diagram__icon-btn"
                  onClick={() => moveDiagram(i, 1)}
                  disabled={i === diagrams.length - 1}
                  data-testid={`editor-diagram-move-down-${i}`}
                  aria-label={t('editor.step.text.moveDown', 'Move down')}
                  title={t('editor.step.text.moveDown', 'Move down')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="editor-diagram__icon-btn"
                  onClick={() => duplicateDiagram(i)}
                  data-testid={`editor-diagram-duplicate-${i}`}
                  aria-label={t(
                    'lessons.my.editor.text.diagrams.duplicate',
                    'Duplicate',
                  )}
                  title={t(
                    'lessons.my.editor.text.diagrams.duplicate',
                    'Duplicate',
                  )}
                >
                  ⎘
                </button>
                <button
                  type="button"
                  className="editor-diagram__icon-btn editor-diagram__icon-btn--danger"
                  onClick={() => removeDiagram(i)}
                  data-testid={`editor-diagram-remove-${i}`}
                  aria-label={t(
                    'lessons.my.editor.text.diagrams.delete',
                    'Delete',
                  )}
                  title={t(
                    'lessons.my.editor.text.diagrams.delete',
                    'Delete',
                  )}
                >
                  −
                </button>
              </div>

              {!isCollapsed && (
                <div className="editor-diagram__body">
                  <DiagramEditor
                    fen={d.fen}
                    caption={d.caption}
                    orientation={d.orientation}
                    arrows={d.arrows}
                    highlightedSquares={d.highlightedSquares}
                    onChange={(next) =>
                      updateDiagram(i, {
                        fen: next.fen,
                        caption: next.caption,
                        orientation: next.orientation,
                        arrows: next.arrows,
                        highlightedSquares: next.highlightedSquares,
                      })
                    }
                  />

                  <label className="editor-diagram__fen-label">
                    {t('editor.diagram.fenLabel', 'FEN')}
                    <div className="editor-diagram__fen-row">
                      <input
                        value={d.fen}
                        onChange={(e) => updateDiagramFen(i, e.target.value)}
                        data-testid={`editor-diagram-fen-${i}`}
                      />
                      <button
                        type="button"
                        className="editor-diagram__edit-board"
                        onClick={() => setEditingIdx(i)}
                        data-testid={`editor-diagram-edit-board-${i}`}
                      >
                        {t('editor.step.text.editBoard', 'Edit on board')}
                      </button>
                    </div>
                  </label>
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => {
            const newIndex = diagrams.length;
            const currentMd = payload.bodyMarkdown ?? '';
            const trimmed = currentMd.trimEnd();
            const nextMd =
              trimmed.length === 0
                ? `{{diagram:${newIndex}}}`
                : `${trimmed}\n\n{{diagram:${newIndex}}}`;
            onChange({
              ...payload,
              bodyMarkdown: nextMd,
              diagrams: [...diagrams, makeDefaultDiagram()],
            });
          }}
          data-testid="editor-step-text-add-diagram"
        >
          {t('lessons.my.editor.text.diagrams.add', '+ Add diagram')}
        </button>
      </div>

      {editingIdx !== null && diagrams[editingIdx] && (
        <SetPositionModal
          initialFen={diagrams[editingIdx].fen}
          onApply={(fen) => {
            updateDiagramFen(editingIdx, fen);
            setEditingIdx(null);
          }}
          onClose={() => setEditingIdx(null)}
        />
      )}
    </div>
  );
}
