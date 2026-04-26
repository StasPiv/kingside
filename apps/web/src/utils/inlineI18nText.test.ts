import { describe, it, expect } from 'vitest';

import { resolveInlineText } from './inlineI18nText';

const tStub = (key: string, defOrOpts?: unknown): string => {
  if (typeof defOrOpts === 'string') return `t:${key}|${defOrOpts}`;
  if (defOrOpts && typeof defOrOpts === 'object') {
    const dv = (defOrOpts as { defaultValue?: string }).defaultValue;
    return `t:${key}|${dv ?? ''}`;
  }
  return `t:${key}`;
};

describe('resolveInlineText (KS-1978)', () => {
  it('inline string → возвращает inline (i18n не дёргается)', () => {
    expect(resolveInlineText('Доска и нотация', 'lessons.b.title', tStub, 'b')).toBe(
      'Доска и нотация',
    );
  });

  it('inline=null → fallback на t(i18nKey, fallback)', () => {
    expect(resolveInlineText(null, 'lessons.b.title', tStub, 'b')).toBe(
      't:lessons.b.title|b',
    );
  });

  it('inline=undefined → fallback на t(i18nKey)', () => {
    expect(resolveInlineText(undefined, 'lessons.b.title', tStub, 'fb')).toBe(
      't:lessons.b.title|fb',
    );
  });

  it('inline=пустая строка → не считается значением, fallback на i18n', () => {
    expect(resolveInlineText('', 'lessons.b.title', tStub, 'b')).toBe(
      't:lessons.b.title|b',
    );
  });

  it('inline и i18nKey оба пустые → fallback', () => {
    expect(resolveInlineText(null, null, tStub, 'fb')).toBe('fb');
  });

  it('по умолчанию fallback = ""', () => {
    expect(resolveInlineText(null, null, tStub)).toBe('');
  });
});
