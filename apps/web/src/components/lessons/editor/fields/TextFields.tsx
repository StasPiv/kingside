import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

/**
 * `TextFields` — форма редактирования `TextStepPayload` (markdown + diagrams).
 *
 * Вынесено из inline-варианта в `StepEditor.tsx` (KS-1849 / FE-R1).
 * Публичный API `StepEditor` не меняется — это просто разделение файлов
 * чтобы новые user-course-поля могли переиспользовать / ограничивать
 * состав в FE-R4/R5, не распухая StepEditor.tsx до 1500+ строк.
 *
 * # Автовставка {{diagram:N}} (KS-1827 bugfix)
 *
 * При клике «+ Добавить диаграмму» `{{diagram:N}}`-маркер
 * автоматически дописывается в конец `bodyMarkdown`. `TextStep`
 * рендерит диаграмму только если на неё есть ссылка из markdown либо
 * fenced-block — без автовставки юзер-редактора сохранял «невидимую»
 * диаграмму. Автор может свободно передвинуть маркер в теле md.
 */

interface TextFieldsProps {
  payload: Extract<StepPayload, { type: 'text' }>;
  onChange: (p: StepPayload) => void;
}

export function TextFields({ payload, onChange }: TextFieldsProps) {
  const { t } = useTranslation();
  const diagrams = payload.diagrams ?? [];

  return (
    <div className="editor-step__fields">
      <label>
        {t('editor.step.text.body', 'Markdown body')}
        <textarea
          value={payload.bodyMarkdown ?? ''}
          onChange={(e) => onChange({ ...payload, bodyMarkdown: e.target.value })}
          rows={8}
          data-testid="editor-step-text-body"
        />
      </label>
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
            <label>
              FEN
              <input
                value={d.fen}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = { ...next[i], fen: e.target.value };
                  onChange({ ...payload, diagrams: next });
                }}
                data-testid={`editor-diagram-fen-${i}`}
              />
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
    </div>
  );
}
