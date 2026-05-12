/**
 * KS-2856 / KS-2858 B2. Тесты `validateGamebookPayload` — лимиты
 * и форма payload'а.
 */
import { validateGamebookPayload } from './gamebook.dto';
import { GAMEBOOK_LIMITS } from '../study-limits';

describe('validateGamebookPayload — KS-2858 B2', () => {
  it('пустой payload → {}', () => {
    expect(validateGamebookPayload({})).toEqual({});
  });

  it('null/undefined → {}', () => {
    expect(validateGamebookPayload(null)).toEqual({});
    expect(validateGamebookPayload(undefined)).toEqual({});
  });

  it('intro корректен → пробрасывается', () => {
    expect(
      validateGamebookPayload({ intro: 'Welcome!' }),
    ).toEqual({ intro: 'Welcome!' });
  });

  it('intro слишком длинный → Error', () => {
    const longIntro = 'a'.repeat(GAMEBOOK_LIMITS.introMaxLength + 1);
    expect(() =>
      validateGamebookPayload({ intro: longIntro }),
    ).toThrow(/too long/);
  });

  it('intro не строка → Error', () => {
    expect(() => validateGamebookPayload({ intro: 42 })).toThrow(
      /must be a string/,
    );
  });

  it('byUci корректен → пробрасывается', () => {
    const r = validateGamebookPayload({
      byUci: {
        e2e4: { success: 'хорошо', failure: 'неверно' },
        d7d5: { hint: 'попробуй пешку' },
      },
    });
    expect(r.byUci).toEqual({
      e2e4: { success: 'хорошо', failure: 'неверно' },
      d7d5: { hint: 'попробуй пешку' },
    });
  });

  it('byUci с превышением maxNodes → Error', () => {
    // Генерируем maxNodes+1 уникальных 4-символьных ключа из набора a-z.
    const byUci: Record<string, unknown> = {};
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let count = 0;
    for (const a of letters) {
      for (const b of letters) {
        for (const c of letters) {
          for (const d of letters) {
            if (count >= GAMEBOOK_LIMITS.maxNodes + 1) break;
            byUci[`${a}${b}${c}${d}`] = { hint: 'x' };
            count++;
          }
          if (count >= GAMEBOOK_LIMITS.maxNodes + 1) break;
        }
        if (count >= GAMEBOOK_LIMITS.maxNodes + 1) break;
      }
      if (count >= GAMEBOOK_LIMITS.maxNodes + 1) break;
    }
    expect(Object.keys(byUci).length).toBe(GAMEBOOK_LIMITS.maxNodes + 1);
    expect(() => validateGamebookPayload({ byUci })).toThrow(
      /too many nodes/,
    );
  });

  it('byUci ключ неправильной длины → Error', () => {
    expect(() =>
      validateGamebookPayload({ byUci: { xyz: { hint: 'x' } } }),
    ).toThrow(/invalid uci key/);
  });

  it('hint слишком длинный → Error', () => {
    const long = 'x'.repeat(GAMEBOOK_LIMITS.textPerNodeMaxLength + 1);
    expect(() =>
      validateGamebookPayload({ byUci: { e2e4: { hint: long } } }),
    ).toThrow(/too long/);
  });

  it('byUci не объект → Error', () => {
    expect(() => validateGamebookPayload({ byUci: [] })).toThrow(
      /must be an object/,
    );
  });

  it('узел в byUci не объект → Error', () => {
    expect(() =>
      validateGamebookPayload({ byUci: { e2e4: 'x' } }),
    ).toThrow(/must be an object/);
  });

  it('узел: hint не строка → Error', () => {
    expect(() =>
      validateGamebookPayload({ byUci: { e2e4: { hint: 123 } } }),
    ).toThrow(/must be a string/);
  });

  it('массив на верхнем уровне → Error', () => {
    expect(() => validateGamebookPayload([1, 2, 3])).toThrow(
      /must be an object/,
    );
  });
});
