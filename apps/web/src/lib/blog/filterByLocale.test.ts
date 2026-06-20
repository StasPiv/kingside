/**
 * KS-4394 / ADR-137 T2 §2.3. Тесты разрешения локали статьи.
 */
import { describe, it, expect } from 'vitest';
import { filterByLocale } from './filterByLocale';
import type { BlogIndexEntry } from '../../types/blog';

function entry(
  slug: string,
  locale: 'ru' | 'en',
  publishedAt: string,
  draft = false,
): BlogIndexEntry {
  return {
    title: `${slug}-${locale}`,
    description: 'd',
    slug,
    locale,
    publishedAt,
    updatedAt: publishedAt,
    author: 'kingside',
    tags: [],
    readingTimeMin: 1,
    draft,
  };
}

const A_RU = entry('a', 'ru', '2026-06-20');
const A_EN = entry('a', 'en', '2026-06-20');
const B_RU = entry('b', 'ru', '2026-06-19');
const C_EN = entry('c', 'en', '2026-06-18');

describe('filterByLocale', () => {
  it('возвращает по одной записи на slug, приоритет — точная локаль', () => {
    const out = filterByLocale([A_RU, A_EN, B_RU, C_EN], 'ru');
    expect(out.map((e) => `${e.slug}-${e.locale}`)).toEqual([
      'a-ru',
      'b-ru',
      'c-en',
    ]);
  });

  it('помечает запись фолбэка флагом isLocaleFallback', () => {
    const out = filterByLocale([A_RU, A_EN, B_RU, C_EN], 'ru');
    const c = out.find((e) => e.slug === 'c')!;
    expect(c.isLocaleFallback).toBe(true);
    const a = out.find((e) => e.slug === 'a')!;
    expect(a.isLocaleFallback).toBe(false);
  });

  it('allowFallback=false отсекает slug-и без нужной локали', () => {
    const out = filterByLocale([A_RU, A_EN, B_RU, C_EN], 'ru', {
      allowFallback: false,
    });
    expect(out.map((e) => e.slug)).toEqual(['a', 'b']);
  });

  it('сохраняет порядок появления slug-ов', () => {
    const out = filterByLocale([C_EN, A_RU, B_RU], 'ru');
    expect(out.map((e) => e.slug)).toEqual(['c', 'a', 'b']);
  });

  it('пустой массив → пустой результат', () => {
    expect(filterByLocale([], 'ru')).toEqual([]);
  });
});
