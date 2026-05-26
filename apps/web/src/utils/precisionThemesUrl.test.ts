import { describe, it, expect } from 'vitest';
import {
  readPrecisionThemesFromUrl,
  writePrecisionThemesToUrl,
} from './precisionThemesUrl';

/**
 * KS-3362 (ADR-080 §7 F2). URL-state хелперы для precision-тем.
 */

describe('readPrecisionThemesFromUrl', () => {
  it('пустой URL → []', () => {
    expect(readPrecisionThemesFromUrl(new URLSearchParams(''))).toEqual([]);
  });

  it('?themes=pin → [pin]', () => {
    expect(
      readPrecisionThemesFromUrl(new URLSearchParams('themes=pin')),
    ).toEqual(['pin']);
  });

  it('?themes=pin,fork,sacrifice → 3 темы в порядке URL', () => {
    expect(
      readPrecisionThemesFromUrl(
        new URLSearchParams('themes=pin,fork,sacrifice'),
      ),
    ).toEqual(['pin', 'fork', 'sacrifice']);
  });

  it('whitelist: невалидные ключи отбрасываются', () => {
    expect(
      readPrecisionThemesFromUrl(
        new URLSearchParams('themes=pin,master,nonsense,fork'),
      ),
    ).toEqual(['pin', 'fork']);
  });

  it('дубликаты схлопываются (порядок первого вхождения)', () => {
    expect(
      readPrecisionThemesFromUrl(
        new URLSearchParams('themes=fork,pin,fork'),
      ),
    ).toEqual(['fork', 'pin']);
  });

  it('пустые элементы (запятая-запятая) игнорируются', () => {
    expect(
      readPrecisionThemesFromUrl(
        new URLSearchParams('themes=,pin,,fork,'),
      ),
    ).toEqual(['pin', 'fork']);
  });
});

describe('writePrecisionThemesToUrl', () => {
  it('пустой массив → удаляет параметр', () => {
    const sp = writePrecisionThemesToUrl(
      new URLSearchParams('themes=pin&scope=server'),
      [],
    );
    expect(sp.has('themes')).toBe(false);
    expect(sp.get('scope')).toBe('server');
  });

  it('темы сортируются по порядку whitelist (стабильный URL)', () => {
    // pin индекс 0, fork 1, sacrifice 5 — порядок одинаковый
    // независимо от порядка ввода.
    expect(
      writePrecisionThemesToUrl(new URLSearchParams(''), [
        'sacrifice',
        'pin',
        'fork',
      ]).get('themes'),
    ).toBe('pin,fork,sacrifice');
  });

  it('невалидные ключи отбрасываются при записи', () => {
    expect(
      writePrecisionThemesToUrl(new URLSearchParams(''), [
        'pin',
        'foo',
        'fork',
      ]).get('themes'),
    ).toBe('pin,fork');
  });

  it('сохраняет другие параметры', () => {
    const sp = writePrecisionThemesToUrl(
      new URLSearchParams('scope=drafts&objective=convertAdvantage'),
      ['pin'],
    );
    expect(sp.get('themes')).toBe('pin');
    expect(sp.get('scope')).toBe('drafts');
    expect(sp.get('objective')).toBe('convertAdvantage');
  });
});
