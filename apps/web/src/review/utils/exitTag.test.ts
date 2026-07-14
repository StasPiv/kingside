/**
 * KS-4953. Тесты парсинга [%exit …] и счётчика недостроенных веток.
 */
import { describe, it, expect } from 'vitest';

import { parseExitTag, countUnfinishedBranches, type ExitTreeNode } from './exitTag';

describe('parseExitTag', () => {
  it('извлекает kind и остаток текста', () => {
    expect(parseExitTag('[%exit theory] дебют пройден')).toEqual({
      kind: 'theory',
      text: 'дебют пройден',
    });
    expect(parseExitTag('[%exit refuted] SF +2.50')).toEqual({
      kind: 'refuted',
      text: 'SF +2.50',
    });
    expect(parseExitTag('[%exit limit] обрыв по лимиту')).toEqual({
      kind: 'limit',
      text: 'обрыв по лимиту',
    });
  });

  it('без тега → kind null, текст как есть', () => {
    expect(parseExitTag('e5 (Maia 40%, 92%)')).toEqual({
      kind: null,
      text: 'e5 (Maia 40%, 92%)',
    });
  });

  it('пустой/undefined → kind null', () => {
    expect(parseExitTag(undefined).kind).toBeNull();
    expect(parseExitTag('').kind).toBeNull();
  });

  it('регистр и лишние пробелы', () => {
    expect(parseExitTag('[%exit TRANSPOSITION]  →').kind).toBe('transposition');
  });
});

describe('countUnfinishedBranches', () => {
  const leaf = (comment?: string): ExitTreeNode => ({ comment });

  it('считает [%exit limit] в основной линии и вариациях', () => {
    const v1 = leaf('[%exit limit] обрыв');
    const v2 = leaf('[%exit theory] дебют');
    const root: ExitTreeNode = {
      comment: undefined,
      next: leaf('[%exit limit] обрыв'),
      variations: [[v1], [v2]],
    };
    expect(countUnfinishedBranches([root])).toBe(2); // next-limit + v1-limit
  });

  it('нет limit → 0', () => {
    expect(countUnfinishedBranches([leaf('[%exit theory] x')])).toBe(0);
    expect(countUnfinishedBranches([])).toBe(0);
    expect(countUnfinishedBranches(null)).toBe(0);
  });

  it('цикл не зацикливает', () => {
    const a = leaf('[%exit limit] a');
    const b = leaf('[%exit limit] b');
    a.next = b;
    b.next = a;
    expect(countUnfinishedBranches([a])).toBe(2);
  });
});
