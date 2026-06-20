/**
 * KS-4394 / ADR-137 T2. Тесты findPost / availableLocalesIn.
 */
import { describe, it, expect } from 'vitest';
import { availableLocalesIn, findPost } from './findPost';
import type { BlogIndexEntry } from '../../types/blog';

function entry(
  slug: string,
  locale: 'ru' | 'en',
): BlogIndexEntry {
  return {
    title: `${slug}-${locale}`,
    description: 'd',
    slug,
    locale,
    publishedAt: '2026-06-20',
    updatedAt: '2026-06-20',
    author: 'kingside',
    tags: [],
    readingTimeMin: 1,
  };
}

const A_RU = entry('a', 'ru');
const A_EN = entry('a', 'en');
const B_EN = entry('b', 'en');

describe('findPost', () => {
  it('возвращает точное совпадение без фолбэка', () => {
    const out = findPost([A_RU, A_EN, B_EN], 'a', 'ru');
    expect(out).not.toBeNull();
    expect(out!.locale).toBe('ru');
    expect(out!.isLocaleFallback).toBe(false);
  });

  it('фолбэк на другую локаль если оригинал отсутствует', () => {
    const out = findPost([A_RU, B_EN], 'b', 'ru');
    expect(out).not.toBeNull();
    expect(out!.locale).toBe('en');
    expect(out!.isLocaleFallback).toBe(true);
  });

  it('allowFallback=false возвращает null если нет точной локали', () => {
    expect(
      findPost([B_EN], 'b', 'ru', { allowFallback: false }),
    ).toBeNull();
  });

  it('возвращает null если slug не найден вообще', () => {
    expect(findPost([A_RU, B_EN], 'zzz', 'ru')).toBeNull();
  });
});

describe('availableLocalesIn', () => {
  it('перечень локалей по slug', () => {
    expect(availableLocalesIn([A_RU, A_EN, B_EN], 'a')).toEqual([
      'ru',
      'en',
    ]);
    expect(availableLocalesIn([A_RU, A_EN, B_EN], 'b')).toEqual(['en']);
    expect(availableLocalesIn([A_RU, A_EN, B_EN], 'zzz')).toEqual([]);
  });

  it('дубликаты не учитываются', () => {
    expect(availableLocalesIn([A_RU, A_RU, A_EN], 'a')).toEqual([
      'ru',
      'en',
    ]);
  });
});
