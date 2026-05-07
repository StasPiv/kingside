import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { QuizQuestion, QuizStepPayload } from '@kingside/shared';

import { renderWithProviders } from '../../../../test/test-utils';

/**
 * KS-2573: тесты QuizStepEditor.
 *
 * `<DiagramEditor>` мокаем — у него собственные тесты (KS-2571);
 * нас интересует только что drawingDisabled пробрасывается, FEN
 * показывается и onChange при изменении FEN-а через DiagramEditor
 * пробрасывается в payload.
 */
vi.mock('../shared/DiagramEditor', () => ({
  DiagramEditor: (props: {
    fen: string;
    drawingDisabled?: boolean;
    onChange: (next: { fen: string }) => void;
  }) => (
    <div
      data-testid="diagram-editor-mock"
      data-fen={props.fen}
      data-drawing-disabled={props.drawingDisabled ? 'true' : 'false'}
    >
      <button
        type="button"
        data-testid="diagram-editor-mock-set-fen"
        onClick={() =>
          props.onChange({ fen: '8/8/8/8/4k3/8/4K3/8 w - - 0 1' })
        }
      >
        set-fen
      </button>
    </div>
  ),
}));

import { QuizStepEditor } from './QuizStepEditor';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeQuestion(over: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: 'q-1',
    prompt: 'What is 2+2?',
    options: [
      { id: 'a', label: '3' },
      { id: 'b', label: '4' },
    ],
    correctOptionIds: ['b'],
    ...over,
  };
}

function renderEditor(initial?: Partial<QuizStepPayload>) {
  const onChange = vi.fn<(next: QuizStepPayload) => void>();
  const payload: QuizStepPayload = {
    type: 'quiz',
    questions: initial?.questions ?? [],
    passThreshold: initial?.passThreshold,
  };
  const utils = renderWithProviders(
    <QuizStepEditor payload={payload} onChange={onChange} />,
  );
  return { ...utils, onChange };
}

describe('<QuizStepEditor> KS-2573', () => {
  it('пустой payload → видна только кнопка «+ Добавить вопрос»', () => {
    renderEditor();
    expect(screen.getByTestId('quiz-step-editor')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-add-question')).toBeInTheDocument();
    expect(screen.queryByTestId('quiz-question-0')).not.toBeInTheDocument();
  });

  it('кнопка «+ Добавить вопрос» добавляет дефолтный вопрос с двумя пустыми опциями', () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByTestId('quiz-add-question'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions).toHaveLength(1);
    const q = updated.questions[0];
    expect(q.prompt).toBe('');
    expect(q.options).toHaveLength(2);
    expect(q.options[0].id).toBe('a');
    expect(q.options[1].id).toBe('b');
    expect(q.correctOptionIds).toEqual([]);
  });

  it('рендерит вопрос со списком опций и заголовком «Question N»', () => {
    renderEditor({ questions: [makeQuestion()] });
    expect(screen.getByTestId('quiz-question-0')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-question-prompt-0')).toHaveValue(
      'What is 2+2?',
    );
    expect(screen.getByTestId('quiz-option-0-0')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-option-0-1')).toBeInTheDocument();
    expect(screen.getByText('Question 1')).toBeInTheDocument();
  });

  it('изменение prompt вызывает onChange с новым значением', () => {
    const { onChange } = renderEditor({ questions: [makeQuestion()] });
    fireEvent.change(screen.getByTestId('quiz-question-prompt-0'), {
      target: { value: 'What is 3+3?' },
    });
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].prompt).toBe('What is 3+3?');
  });

  it('добавление третьей опции и пометка её правильной (single-mode = заменяет правильную)', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion()],
    });
    fireEvent.click(screen.getByTestId('quiz-add-option-0'));
    let updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].options).toHaveLength(3);
    expect(updated.questions[0].options[2].id).toBe('c');
    expect(updated.questions[0].options[2].label).toBe('');

    // re-render с новым state — payload контролируем извне, поэтому
    // эмулируем второй вызов с обновлённым state.
    onChange.mockClear();
    renderWithProviders(
      <QuizStepEditor
        payload={updated}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('quiz-option-correct-0-2'));
    updated = onChange.mock.calls[0][0];
    // single-correct: помечаем 3-й → старый «b» снят, новый «c» правильный
    expect(updated.questions[0].correctOptionIds).toEqual(['c']);
  });

  it('multi=true → checkbox правильного добавляет, не заменяет', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ multi: true, correctOptionIds: ['b'] })],
    });
    fireEvent.click(screen.getByTestId('quiz-option-correct-0-0'));
    const updated = onChange.mock.calls[0][0];
    // оба остались правильные
    expect(updated.questions[0].correctOptionIds).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
    expect(updated.questions[0].correctOptionIds).toHaveLength(2);
  });

  it('multi=true → multi=false с >1 правильным оставляет первый', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ multi: true, correctOptionIds: ['a', 'b'] })],
    });
    fireEvent.click(screen.getByTestId('quiz-question-multi-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].multi).toBe(false);
    expect(updated.questions[0].correctOptionIds).toEqual(['a']);
  });

  it('изменение текста опции пишет в options[j].label', () => {
    const { onChange } = renderEditor({ questions: [makeQuestion()] });
    fireEvent.change(screen.getByTestId('quiz-option-label-0-0'), {
      target: { value: 'Three' },
    });
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].options[0].label).toBe('Three');
  });

  it('удаление опции снимает её из correctOptionIds', () => {
    const { onChange } = renderEditor({
      questions: [
        makeQuestion({
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
          correctOptionIds: ['c'],
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('quiz-option-remove-0-2'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].options).toHaveLength(2);
    expect(updated.questions[0].correctOptionIds).toEqual([]);
  });

  it('UI-лимит 6 опций — кнопка «+ Добавить опцию» становится disabled', () => {
    renderEditor({
      questions: [
        makeQuestion({
          options: [
            { id: 'a', label: '1' },
            { id: 'b', label: '2' },
            { id: 'c', label: '3' },
            { id: 'd', label: '4' },
            { id: 'e', label: '5' },
            { id: 'f', label: '6' },
          ],
          correctOptionIds: ['a'],
        }),
      ],
    });
    expect(screen.getByTestId('quiz-add-option-0')).toBeDisabled();
  });

  it('добавление FEN: «+ Добавить позицию» → DiagramEditor виден с drawingDisabled', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion()],
    });
    expect(
      screen.queryByTestId('diagram-editor-mock'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quiz-question-add-fen-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].fen).toBe(STARTING_FEN);
  });

  it('FEN секция: DiagramEditor рендерится с drawingDisabled=true', () => {
    renderEditor({
      questions: [makeQuestion({ fen: STARTING_FEN })],
    });
    const editor = screen.getByTestId('diagram-editor-mock');
    expect(editor.dataset.fen).toBe(STARTING_FEN);
    expect(editor.dataset.drawingDisabled).toBe('true');
  });

  it('изменение FEN через DiagramEditor пробрасывается в onChange', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ fen: STARTING_FEN })],
    });
    fireEvent.click(screen.getByTestId('diagram-editor-mock-set-fen'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].fen).toBe('8/8/8/8/4k3/8/4K3/8 w - - 0 1');
  });

  it('«Удалить позицию» убирает fen из вопроса', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ fen: STARTING_FEN })],
    });
    fireEvent.click(screen.getByTestId('quiz-question-remove-fen-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0]).not.toHaveProperty('fen');
  });

  it('кнопка «Удалить вопрос» удаляет запись из questions[]', () => {
    const { onChange } = renderEditor({
      questions: [
        makeQuestion(),
        makeQuestion({ id: 'q-2', prompt: 'Other?' }),
      ],
    });
    fireEvent.click(screen.getByTestId('quiz-question-remove-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions).toHaveLength(1);
    expect(updated.questions[0].id).toBe('q-2');
  });

  it('кнопка «Дублировать» создаёт глубокую копию вопроса с новым id', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion()],
    });
    fireEvent.click(screen.getByTestId('quiz-question-duplicate-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions).toHaveLength(2);
    expect(updated.questions[1].id).not.toBe(updated.questions[0].id);
    expect(updated.questions[1].prompt).toBe(updated.questions[0].prompt);
    // глубокая копия — массивы не shared
    expect(updated.questions[1].options).not.toBe(
      updated.questions[0].options,
    );
    expect(updated.questions[1].correctOptionIds).toEqual(
      updated.questions[0].correctOptionIds,
    );
    expect(updated.questions[1].correctOptionIds).not.toBe(
      updated.questions[0].correctOptionIds,
    );
  });

  it('валидация: пустой prompt → red border + бейдж «Needs attention»', () => {
    renderEditor({
      questions: [makeQuestion({ prompt: '' })],
    });
    const card = screen.getByTestId('quiz-question-0');
    expect(card.dataset.invalid).toBe('true');
    expect(screen.getByTestId('quiz-question-invalid-0')).toBeInTheDocument();
  });

  it('валидация: один правильный option → НЕ инвалид, бейдж скрыт', () => {
    renderEditor({
      questions: [makeQuestion()], // prompt + 2 options + 1 correct
    });
    const card = screen.getByTestId('quiz-question-0');
    expect(card.dataset.invalid).toBe('false');
    expect(
      screen.queryByTestId('quiz-question-invalid-0'),
    ).not.toBeInTheDocument();
  });

  it('валидация: пустой correctOptionIds → инвалид', () => {
    renderEditor({
      questions: [makeQuestion({ correctOptionIds: [] })],
    });
    const card = screen.getByTestId('quiz-question-0');
    expect(card.dataset.invalid).toBe('true');
  });

  it('валидация: пустой label опции → инвалид', () => {
    renderEditor({
      questions: [
        makeQuestion({
          options: [
            { id: 'a', label: '' },
            { id: 'b', label: 'B' },
          ],
        }),
      ],
    });
    const card = screen.getByTestId('quiz-question-0');
    expect(card.dataset.invalid).toBe('true');
  });

  it('collapse-toggle сворачивает body вопроса', () => {
    renderEditor({
      questions: [makeQuestion()],
    });
    expect(screen.getByTestId('quiz-question-prompt-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quiz-question-toggle-0'));
    expect(
      screen.queryByTestId('quiz-question-prompt-0'),
    ).not.toBeInTheDocument();
  });

  it('passThreshold изменение пробрасывается в onChange', () => {
    const { onChange } = renderEditor({ passThreshold: 0.7 });
    fireEvent.change(screen.getByTestId('quiz-pass-threshold'), {
      target: { value: '0.85' },
    });
    const updated = onChange.mock.calls[0][0];
    expect(updated.passThreshold).toBeCloseTo(0.85);
  });

  it('drag-handle для вопросов и опций присутствуют (DnD-смыслом покрывается ReorderableList.test)', () => {
    renderEditor({ questions: [makeQuestion()] });
    expect(screen.getByTestId('quiz-question-handle-0')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-option-handle-0-0')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-option-handle-0-1')).toBeInTheDocument();
  });

  it('добавление вопроса при наличии других → новый вопрос с уникальным id', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ id: 'q-1' }), makeQuestion({ id: 'q-2' })],
    });
    fireEvent.click(screen.getByTestId('quiz-add-question'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions).toHaveLength(3);
    const ids = updated.questions.map((q: QuizQuestion) => q.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('добавление опции при наличии «a», «b», «c» → новая «d»', () => {
    const { onChange } = renderEditor({
      questions: [
        makeQuestion({
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('quiz-add-option-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].options[3].id).toBe('d');
  });

  it('сохранение и переключение «Multi» НЕ удаляет существующий single correct', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ multi: false, correctOptionIds: ['b'] })],
    });
    fireEvent.click(screen.getByTestId('quiz-question-multi-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].multi).toBe(true);
    expect(updated.questions[0].correctOptionIds).toEqual(['b']);
  });

  it('explanation textarea пробрасывает изменения', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion()],
    });
    fireEvent.change(screen.getByTestId('quiz-question-explanation-0'), {
      target: { value: '2+2 is 4 because…' },
    });
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].explanation).toBe('2+2 is 4 because…');
  });

  it('очистка explanation (пустая строка) → undefined', () => {
    const { onChange } = renderEditor({
      questions: [makeQuestion({ explanation: 'foo' })],
    });
    fireEvent.change(screen.getByTestId('quiz-question-explanation-0'), {
      target: { value: '' },
    });
    const updated = onChange.mock.calls[0][0];
    expect(updated.questions[0].explanation).toBeUndefined();
  });
});

describe('<QuizStepEditor> KS-2573 acceptance scenario', () => {
  /**
   * По acceptance: рендерит вопрос с двумя опциями, симулирует
   * добавление третьей и отметку её правильной, проверяет onChange.
   */
  it('add option + mark correct (acceptance)', () => {
    const onChange = vi.fn<(next: QuizStepPayload) => void>();
    const initial: QuizStepPayload = {
      type: 'quiz',
      questions: [makeQuestion()], // 2 options, b correct
    };
    const { rerender } = renderWithProviders(
      <QuizStepEditor payload={initial} onChange={onChange} />,
    );

    // 1. добавить третью
    fireEvent.click(screen.getByTestId('quiz-add-option-0'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const afterAdd = onChange.mock.calls[0][0];
    expect(afterAdd.questions[0].options).toHaveLength(3);

    // 2. ре-рендер с новым state, отметить третью
    rerender(<QuizStepEditor payload={afterAdd} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('quiz-option-correct-0-2'));
    expect(onChange).toHaveBeenCalledTimes(2);
    const afterCorrect = onChange.mock.calls[1][0];
    // single-correct: c заменил b
    expect(afterCorrect.questions[0].correctOptionIds).toEqual(['c']);

    // Дополнительно проверяем что текст можно изменить
    const card = within(screen.getByTestId('quiz-option-0-2'));
    expect(card.getByTestId('quiz-option-label-0-2')).toBeInTheDocument();
  });
});
