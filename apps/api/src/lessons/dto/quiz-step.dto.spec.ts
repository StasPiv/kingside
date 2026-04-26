/**
 * KS-1980/KS-1982: тесты на inline-контракт QuizQuestion / QuizOption.
 *
 * Контракт (KS-1982):
 *  - `QuizQuestion`: `prompt: string` обязателен, `explanation?: string` опц.
 *  - `QuizOption`: `label: string` обязателен.
 *  - i18n-ключи (`promptI18nKey` / `labelI18nKey` / `explanationI18nKey`) удалены
 *    из контракта — англоязычные курсы заводятся отдельной записью в БД,
 *    не переводом существующего русского quiz'а.
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

describe('QuizStepPayloadDto inline contract (KS-1980/KS-1982)', () => {
  const baseQuestion = {
    id: 'q1',
    prompt: 'Сколько клеток на шахматной доске?',
    options: [
      { id: 'a', label: '32' },
      { id: 'b', label: '64' },
    ],
    correctOptionIds: ['b'],
  };

  it('минимальный payload (prompt + 2 option.label + correct) — валиден', async () => {
    expect(
      await validatePayload({ type: 'quiz', questions: [baseQuestion] }),
    ).toEqual([]);
  });

  it('с explanation — валиден', async () => {
    expect(
      await validatePayload({
        type: 'quiz',
        questions: [{ ...baseQuestion, explanation: '8 рядов по 8 = 64.' }],
      }),
    ).toEqual([]);
  });

  it('FEN-диаграмма над вопросом — валидна', async () => {
    expect(
      await validatePayload({
        type: 'quiz',
        questions: [
          {
            ...baseQuestion,
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('multi=true с двумя correctOptionIds — валидно', async () => {
    expect(
      await validatePayload({
        type: 'quiz',
        questions: [
          {
            ...baseQuestion,
            multi: true,
            correctOptionIds: ['a', 'b'],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('prompt отсутствует → ошибка', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [{ ...baseQuestion, prompt: undefined }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/prompt/);
  });

  it('option без label → ошибка', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          options: [
            { id: 'a' },
            { id: 'b', label: '64' },
          ],
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/label/);
  });

  it('prompt не строка → ошибка', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [{ ...baseQuestion, prompt: 42 as unknown as string }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/prompt/);
  });

  it('label не строка → ошибка', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        {
          ...baseQuestion,
          options: [
            { id: 'a', label: 0 as unknown as string },
            { id: 'b', label: '64' },
          ],
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toMatch(/label/);
  });

  it('меньше 2 options → ошибка (ArrayMinSize)', async () => {
    const errors = await validatePayload({
      type: 'quiz',
      questions: [
        { ...baseQuestion, options: [{ id: 'a', label: 'единственный' }] },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
