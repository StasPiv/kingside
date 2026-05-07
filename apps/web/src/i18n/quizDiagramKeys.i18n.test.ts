import { describe, it, expect } from 'vitest';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

/**
 * KS-2575: snapshot-проверка наличия и парности ключей i18n для
 * compoнентов user-courses parity (DiagramEditor / TextStepEditor /
 * QuizStepEditor / StepTypePicker).
 *
 * Список — это контракт KS-2575. Если кто-то удалил ключ из en или ru,
 * этот тест упадёт и предупредит, что UI получит fallback-строку
 * (например, «lessons.my.editor.quiz.questions.title» в виде литерала).
 */

const REQUIRED_KEYS: ReadonlyArray<string> = [
  // Step type select (KS-2574 + финал в KS-2575)
  'lessons.my.editor.stepType.quiz',
  'lessons.my.editor.stepType.quizDescription',
  'lessons.my.editor.stepType.text',
  'lessons.my.editor.stepType.puzzle',
  'lessons.my.editor.stepType.endgameDrill',

  // TextStepEditor — диаграммы (KS-2572 + финал в KS-2575)
  'lessons.my.editor.text.diagrams.title',
  'lessons.my.editor.text.diagrams.add',
  'lessons.my.editor.text.diagrams.itemTitle',
  'lessons.my.editor.text.diagrams.delete',
  'lessons.my.editor.text.diagrams.duplicate',
  'lessons.my.editor.text.diagrams.placeholderHint',
  'lessons.my.editor.text.diagrams.unusedWarning',

  // DiagramEditor (KS-2571 + финал в KS-2575)
  'editor.diagram.caption',
  'editor.diagram.orientation.label',
  'editor.diagram.orientation.white',
  'editor.diagram.orientation.black',
  'editor.diagram.clearArrows',
  'editor.diagram.clearHighlights',
  'editor.diagram.resetFen',
  'editor.diagram.modeDrag',
  'editor.diagram.modeDraw',
  'editor.diagram.fenLabel',
  'editor.diagram.hint.draw',

  // QuizStepEditor (KS-2573 + финал в KS-2575)
  'lessons.my.editor.quiz.questions.title',
  'lessons.my.editor.quiz.addQuestion',
  'lessons.my.editor.quiz.questionPrompt',
  'lessons.my.editor.quiz.questionPositionAdd',
  'lessons.my.editor.quiz.questionPositionRemove',
  'lessons.my.editor.quiz.options.title',
  'lessons.my.editor.quiz.addOption',
  'lessons.my.editor.quiz.optionCorrect',
  'lessons.my.editor.quiz.explanation',
  'lessons.my.editor.quiz.deleteQuestion',
  'lessons.my.editor.quiz.duplicateQuestion',
  'lessons.my.editor.quiz.validation.minOptions',
  'lessons.my.editor.quiz.validation.noCorrect',
];

function lookup(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

describe('KS-2575: i18n keys for quiz / DiagramEditor / TextStepEditor', () => {
  for (const key of REQUIRED_KEYS) {
    it(`en содержит "${key}"`, () => {
      const v = lookup(en, key);
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    });

    it(`ru содержит "${key}"`, () => {
      const v = lookup(ru, key);
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    });
  }

  it('en и ru не содержат пустых строк / fallback-литералов под этими путями', () => {
    for (const key of REQUIRED_KEYS) {
      const enVal = lookup(en, key) as string | undefined;
      const ruVal = lookup(ru, key) as string | undefined;
      // Защита от опечаток вида «вставил ключ как ключ а не как
      // перевод»: значение не должно совпадать с самим ключом.
      expect(enVal, `en[${key}]`).not.toBe(key);
      expect(ruVal, `ru[${key}]`).not.toBe(key);
    }
  });
});
