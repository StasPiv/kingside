import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

import { MarkdownTextEditor } from './MarkdownTextEditor';
import { SetPositionModal } from '../../../SetPositionModal';

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
 * текст, никакого экранирования и трансформаций. Toolbar генерит
 * только тот синтаксис, который понимает read-only рендерер
 * `simpleMarkdown.tsx`.
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
 * она открывает `<SetPositionModal>` (тот же редактор позиций, что
 * используется в `AnalysisPage`). Apply пишет новый FEN в
 * `payload.diagrams[editingIdx].fen` через тот же `onChange`-механизм,
 * что и ручной ввод в input. Cancel/Close ничего не меняет.
 * `SetPositionModal` переиспользуется как есть — никаких правок.
 */

interface TextFieldsProps {
  payload: Extract<StepPayload, { type: 'text' }>;
  onChange: (p: StepPayload) => void;
}

export function TextFields({ payload, onChange }: TextFieldsProps) {
  const { t } = useTranslation();
  const diagrams = payload.diagrams ?? [];
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const updateDiagramFen = (idx: number, fen: string) => {
    const next = diagrams.slice();
    if (!next[idx]) return;
    next[idx] = { ...next[idx], fen };
    onChange({ ...payload, diagrams: next });
  };

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
        <h4>{t('editor.step.text.diagrams', 'Diagrams')}</h4>
        <p className="editor-step__hint" data-testid="editor-diagrams-hint">
          {t(
            'editor.step.text.diagramHint',
            'Add a diagram below, then place {{diagram:N}} marker in the markdown where you want it to appear.',
          )}
        </p>
        {diagrams.map((d, i) => (
          <div key={i} className="editor-diagram">
            <div
              className="editor-diagram__ref"
              data-testid={`editor-diagram-ref-${i}`}
              title={t(
                'editor.step.text.diagramRefHint',
                'Paste this marker into the markdown where the diagram should appear.',
              )}
            >
              <code>{`{{diagram:${i}}}`}</code>
            </div>
            <label className="editor-diagram__fen-label">
              FEN
              <div className="editor-diagram__fen-row">
                <input
                  value={d.fen}
                  onChange={(e) => {
                    const next = diagrams.slice();
                    next[i] = { ...next[i], fen: e.target.value };
                    onChange({ ...payload, diagrams: next });
                  }}
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
            <label>
              {t('editor.step.text.caption', 'Caption')}
              <input
                value={d.caption ?? ''}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = { ...next[i], caption: e.target.value };
                  onChange({ ...payload, diagrams: next });
                }}
              />
            </label>
            <label>
              {t('editor.step.text.orientation', 'Orientation')}
              <select
                value={d.orientation ?? 'white'}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = {
                    ...next[i],
                    orientation: e.target.value as 'white' | 'black',
                  };
                  onChange({ ...payload, diagrams: next });
                }}
              >
                <option value="white">white</option>
                <option value="black">black</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                const next = diagrams.slice();
                next.splice(i, 1);
                onChange({ ...payload, diagrams: next });
              }}
            >
              −
            </button>
          </div>
        ))}
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
              diagrams: [
                ...diagrams,
                {
                  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                  orientation: 'white',
                },
              ],
            });
          }}
          data-testid="editor-step-text-add-diagram"
        >
          + {t('editor.step.text.addDiagram', 'Add diagram')}
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
