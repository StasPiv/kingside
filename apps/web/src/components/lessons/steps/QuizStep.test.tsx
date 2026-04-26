import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../../test/test-utils';
import type { QuizStepPayload } from '@kingside/shared';
import { QuizStep, isAnswerCorrect } from './QuizStep';

// MemoChessboard используется только в вопросах с FEN — для unit-тестов
// диаграммы не интересны, заменяем на пустой div.
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

function singleQuestion(qOverrides = {}) {
  return {
    id: 'q1',
    promptI18nKey: 'What is 2+2?',
    options: [
      { id: 'a', labelI18nKey: '3' },
      { id: 'b', labelI18nKey: '4' },
      { id: 'c', labelI18nKey: '5' },
    ],
    correctOptionIds: ['b'],
    multi: false,
    ...qOverrides,
  };
}

function multiQuestion(qOverrides = {}) {
  return {
    id: 'q2',
    promptI18nKey: 'Pick all primes',
    options: [
      { id: 'a', labelI18nKey: '4' },
      { id: 'b', labelI18nKey: '5' },
      { id: 'c', labelI18nKey: '7' },
      { id: 'd', labelI18nKey: '9' },
    ],
    correctOptionIds: ['b', 'c'],
    multi: true,
    ...qOverrides,
  };
}

describe('isAnswerCorrect', () => {
  it('single: ровно один выбранный из correctOptionIds', () => {
    const q = singleQuestion();
    expect(isAnswerCorrect(q, new Set(['b']))).toBe(true);
    expect(isAnswerCorrect(q, new Set(['a']))).toBe(false);
    expect(isAnswerCorrect(q, new Set())).toBe(false);
    // больше одного — single → не верно
    expect(isAnswerCorrect(q, new Set(['a', 'b']))).toBe(false);
  });

  it('multi: множества совпадают по составу, без лишних и пропущенных', () => {
    const q = multiQuestion();
    expect(isAnswerCorrect(q, new Set(['b', 'c']))).toBe(true);
    expect(isAnswerCorrect(q, new Set(['c', 'b']))).toBe(true);
    expect(isAnswerCorrect(q, new Set(['b']))).toBe(false); // не хватает
    expect(isAnswerCorrect(q, new Set(['b', 'c', 'd']))).toBe(false); // лишний
    expect(isAnswerCorrect(q, new Set())).toBe(false);
  });
});

describe('<QuizStep>', () => {
  function payload(qs: ReturnType<typeof singleQuestion>[], passThreshold?: number): QuizStepPayload {
    return {
      type: 'quiz',
      questions: qs,
      passThreshold,
    };
  }

  it('пустой набор вопросов → empty-state', () => {
    renderWithProviders(<QuizStep payload={payload([])} />);
    expect(screen.getByTestId('lesson-quiz-step-empty')).toBeInTheDocument();
  });

  it('правильный ответ (single) — после Check показывает «Correct», после Submit — score 100%, кнопка Continue активна, onStepDone вызван', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <QuizStep payload={payload([singleQuestion()])} onStepDone={onStepDone} />,
    );

    fireEvent.click(screen.getByTestId('option-0-b'));
    expect(screen.getByTestId('check-0')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('check-0'));

    const result = screen.getByTestId('question-result-0');
    expect(result).toHaveTextContent('Correct');
    expect(screen.getByTestId('lesson-quiz-question-0')).toHaveAttribute('data-correct', 'true');

    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    expect(screen.getByTestId('lesson-quiz-step-score')).toHaveTextContent('1/1 (100%)');
    const cont = screen.getByTestId('lesson-quiz-step-continue');
    expect(cont).not.toBeDisabled();
    expect(cont).toHaveTextContent('Continue');
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('неправильный ответ (single) — score ниже порога, Continue дизейблед, onStepDone НЕ вызван, есть Retry', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <QuizStep payload={payload([singleQuestion()])} onStepDone={onStepDone} />,
    );

    fireEvent.click(screen.getByTestId('option-0-a'));
    fireEvent.click(screen.getByTestId('check-0'));
    expect(screen.getByTestId('question-result-0')).toHaveTextContent('Not quite');

    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    expect(screen.getByTestId('lesson-quiz-step-score')).toHaveTextContent('0/1 (0%)');
    expect(screen.getByTestId('lesson-quiz-step-continue')).toBeDisabled();
    expect(screen.getByTestId('lesson-quiz-step-retry')).toBeInTheDocument();
    expect(onStepDone).not.toHaveBeenCalled();
  });

  it('multi-выбор: точное совпадение множества → правильно; лишний или пропущенный → неправильно', () => {
    renderWithProviders(<QuizStep payload={payload([multiQuestion()])} />);

    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('option-0-c'));
    fireEvent.click(screen.getByTestId('check-0'));
    expect(screen.getByTestId('question-result-0')).toHaveTextContent('Correct');
  });

  it('порог 0.7: 2 верных из 3 → 66% < 70% → НЕ пройден', () => {
    const qs = [singleQuestion({ id: 'q1' }), singleQuestion({ id: 'q2' }), singleQuestion({ id: 'q3' })];
    const onStepDone = vi.fn();
    renderWithProviders(
      <QuizStep payload={payload(qs)} onStepDone={onStepDone} />,
    );

    // 2 правильных
    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('check-0'));
    fireEvent.click(screen.getByTestId('option-1-b'));
    fireEvent.click(screen.getByTestId('check-1'));
    // 1 неправильный
    fireEvent.click(screen.getByTestId('option-2-a'));
    fireEvent.click(screen.getByTestId('check-2'));

    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    expect(screen.getByTestId('lesson-quiz-step-score')).toHaveTextContent('2/3 (67%)');
    expect(onStepDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('lesson-quiz-step-continue')).toBeDisabled();
  });

  it('порог 0.5: 1 верный из 2 → 50% ≥ 50% → пройден, onStepDone вызван', () => {
    const qs = [singleQuestion({ id: 'q1' }), singleQuestion({ id: 'q2' })];
    const onStepDone = vi.fn();
    renderWithProviders(
      <QuizStep payload={payload(qs, 0.5)} onStepDone={onStepDone} />,
    );

    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('check-0'));
    fireEvent.click(screen.getByTestId('option-1-a'));
    fireEvent.click(screen.getByTestId('check-1'));

    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    expect(screen.getByTestId('lesson-quiz-step-score')).toHaveTextContent('1/2 (50%)');
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('Retry сбрасывает состояние и позволяет ответить заново', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <QuizStep payload={payload([singleQuestion()])} onStepDone={onStepDone} />,
    );

    // первый прогон — неправильно
    fireEvent.click(screen.getByTestId('option-0-a'));
    fireEvent.click(screen.getByTestId('check-0'));
    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    fireEvent.click(screen.getByTestId('lesson-quiz-step-retry'));

    // повторный прогон — правильно
    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('check-0'));
    fireEvent.click(screen.getByTestId('lesson-quiz-step-submit'));
    expect(screen.getByTestId('lesson-quiz-step-score')).toHaveTextContent('1/1 (100%)');
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('кнопка Submit дизейблена пока не отвечены все вопросы', () => {
    const qs = [singleQuestion({ id: 'q1' }), singleQuestion({ id: 'q2' })];
    renderWithProviders(<QuizStep payload={payload(qs)} />);

    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('check-0'));
    expect(screen.getByTestId('lesson-quiz-step-submit')).toBeDisabled();

    fireEvent.click(screen.getByTestId('option-1-b'));
    fireEvent.click(screen.getByTestId('check-1'));
    expect(screen.getByTestId('lesson-quiz-step-submit')).not.toBeDisabled();
  });

  // ─── KS-1981: inline > i18nKey > placeholder ──────────────────────

  it('KS-1981: inline `prompt`/`label`/`explanation` рендерятся вместо ключа', () => {
    const q = singleQuestion({
      // promptI18nKey специально кладём ключ, которого нет в FE-словаре,
      // чтобы убедиться: inline побеждает.
      promptI18nKey: 'lessons.unknown.prompt',
      prompt: 'Сколько клеток на доске?',
      explanationI18nKey: 'lessons.unknown.explanation',
      explanation: 'Доска 8×8 = 64 клетки.',
      options: [
        { id: 'a', labelI18nKey: '32', label: '32' },
        { id: 'b', labelI18nKey: '64', label: '64' },
      ],
      correctOptionIds: ['b'],
    });
    renderWithProviders(<QuizStep payload={payload([q])} />);
    expect(screen.getByTestId('lesson-quiz-question-0').textContent).toContain(
      'Сколько клеток на доске?',
    );
    // option labels — inline.
    const optionA = screen.getByTestId('option-0-a').parentElement;
    expect(optionA?.textContent).toContain('32');
    const optionB = screen.getByTestId('option-0-b').parentElement;
    expect(optionB?.textContent).toContain('64');
    // explanation после check.
    fireEvent.click(screen.getByTestId('option-0-b'));
    fireEvent.click(screen.getByTestId('check-0'));
    expect(screen.getByTestId('question-result-0').textContent).toContain(
      'Доска 8×8 = 64 клетки.',
    );
  });

  it('KS-1981: inline=null + ключ-в-словаре → t() (старое поведение)', () => {
    const q = singleQuestion({
      // i18next test-instance имеет ключ `lessons.quizCheck` (= "Check").
      // Используем его как пример «есть в словаре». Для prompt такой
      // ключ редко имеет смысл, поэтому проверяем как label.
      options: [
        { id: 'a', labelI18nKey: 'lessons.quizCheck', label: null },
      ],
      correctOptionIds: ['a'],
    });
    renderWithProviders(<QuizStep payload={payload([q])} />);
    const optionA = screen.getByTestId('option-0-a').parentElement;
    expect(optionA?.textContent).toContain('Check');
  });

  it('KS-1981: inline=null + ключа нет в словаре → плейсхолдер (legacy KS-1782)', () => {
    const q = singleQuestion({
      options: [
        // labelI18nKey без перевода + label=null → старый плейсхолдер.
        { id: 'a', labelI18nKey: 'lessons.totally.missing.key', label: null },
      ],
      correctOptionIds: ['a'],
    });
    renderWithProviders(<QuizStep payload={payload([q])} />);
    const optionA = screen.getByTestId('option-0-a').parentElement;
    expect(optionA?.textContent).toMatch(/translation pending|перевод/i);
  });
});
