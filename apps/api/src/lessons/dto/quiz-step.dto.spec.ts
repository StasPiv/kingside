/**
 * KS-1980: тесты на inline-поля QuizQuestion / QuizOption.
 *
 * Контракт (KS-1980):
 *  - `QuizQuestion`: добавлено `prompt?: string | null`, `explanation?: string | null`.
 *  - `QuizOption`: добавлено `label?: string | null`.
 *  - FE применяет fallback `inline ?? t(i18nKey)` (по аналогии KS-1965).
 *  - DTO принимает inline через admin API без 400.
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuizStepPayloadDto } from './step-payload.dto';

async function validatePayload(payload: unknown): Promise<string[]> {
  const instance = plainToInstance(QuizStepPayloadDto, payload);
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  const out: string[] = [];
  // class-validator возвращает дерево ошибок (children); собираем DFS.
  function walk(prefix: string, list: typeof errors): void {
    for (const e of list) {
      const path = prefix ? `${prefix}.${e.property}` : e.property;
      for (const msg of Object.values(e.constraints ?? {})) {
        out.push(`${path}: ${msg}`);
      }
      if (e.children?.length) walk(path, e.children);
    }
  }
  walk('', errors);
  return out;
}

describe('QuizStepPayloadDto inline fields (KS-1980)', () => {
  const baseQuestion = {
    id: 'q1',
    promptI18nKey: 'lessons.beginner.q1.prompt',
    options: [
      { id: 'a', labelI18nKey: 'lessons.beginner.q1.opt.a' },
      { id: 'b', labelI18nKey: 'lessons.beginner.q1.opt.b' },
    ],
    correctOptionIds: ['a'],
  };

  it('payload без inline-полей — валиден (back-compat)', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [baseQuestion],
    });
    expect(errors).toEqual([]);
  });

  it('inline `prompt` + `explanation` на вопросе — валидно', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          prompt: 'Сколько клеток на шахматной доске?',
          explanation: '8 рядов по 8 клеток = 64.',
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('inline `label` на варианте — валидно', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          options: [
            { id: 'a', labelI18nKey: 'opt.a', label: '64' },
            { id: 'b', labelI18nKey: 'opt.b', label: '32' },
          ],
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('inline-поля null — валидно (явное обнуление в PATCH)', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          prompt: null,
          explanation: null,
          options: [
            { id: 'a', labelI18nKey: 'opt.a', label: null },
            { id: 'b', labelI18nKey: 'opt.b' },
          ],
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('inline-поля число вместо строки → ошибка валидации', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          prompt: 42,
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/prompt/i);
  });

  it('inline-поле label число → ошибка', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          options: [
            { id: 'a', labelI18nKey: 'opt.a', label: 0 },
            { id: 'b', labelI18nKey: 'opt.b' },
          ],
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('обязательные `*I18nKey` всё ещё обязательны (не удалены)', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          // promptI18nKey: missing
          prompt: 'Текст вопроса',
          options: [
            { id: 'a', labelI18nKey: 'opt.a' },
            { id: 'b', labelI18nKey: 'opt.b' },
          ],
          correctOptionIds: ['a'],
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/promptI18nKey/);
  });
});
