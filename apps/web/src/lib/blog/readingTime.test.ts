/**
 * KS-4394 / ADR-137 T2. Тесты подсчёта времени чтения.
 *
 * Контракт зеркалит `vite-blog-plugin.mjs`. Если меняем WPM здесь —
 * меняем и там, чтобы build-индекс и runtime считали одинаково.
 */
import { describe, it, expect } from 'vitest';
import {
  countWords,
  readingTime,
  stripMarkdown,
  READING_WPM,
} from './readingTime';

describe('stripMarkdown', () => {
  it('убирает кодоблоки', () => {
    expect(stripMarkdown('a\n```\nb b b\n```\nc')).not.toContain('b b');
  });

  it('убирает инлайн-код', () => {
    expect(stripMarkdown('foo `bar baz` qux')).not.toContain('bar baz');
  });

  it('сохраняет текст ссылок, убирает url', () => {
    const out = stripMarkdown('see [link text](https://example.com) here');
    expect(out).toContain('link text');
    expect(out).not.toContain('https');
  });

  it('убирает изображения', () => {
    expect(stripMarkdown('![alt](pic.png) rest')).toContain('rest');
    expect(stripMarkdown('![alt](pic.png) rest')).not.toContain('alt');
  });

  it('убирает форматирование (# > * _ ~ -)', () => {
    const out = stripMarkdown('# Title\n> quote\n*emph* ~strike~ -dash');
    expect(out).not.toContain('#');
    expect(out).not.toContain('>');
    expect(out).not.toContain('*');
  });
});

describe('countWords', () => {
  it('1 слово', () => {
    expect(countWords('hello')).toBe(1);
  });
  it('пустая строка → 0', () => {
    expect(countWords('   ')).toBe(0);
  });
  it('по пробелам и переводам строк', () => {
    expect(countWords('one two\nthree\tfour  five')).toBe(5);
  });
});

describe('readingTime', () => {
  it('минимум 1 минута для пустого текста', () => {
    expect(readingTime('', 'ru')).toBe(1);
    expect(readingTime('     ', 'en')).toBe(1);
  });

  it('ru: 200 слов = 1 мин, 201 = 2 мин (округление вверх)', () => {
    const ru200 = Array(200).fill('слово').join(' ');
    const ru201 = Array(201).fill('слово').join(' ');
    expect(readingTime(ru200, 'ru')).toBe(1);
    expect(readingTime(ru201, 'ru')).toBe(2);
  });

  it('en: 250 слов = 1 мин, 251 = 2 мин', () => {
    const en250 = Array(250).fill('word').join(' ');
    const en251 = Array(251).fill('word').join(' ');
    expect(readingTime(en250, 'en')).toBe(1);
    expect(readingTime(en251, 'en')).toBe(2);
  });

  it('не считает текст внутри кодоблоков', () => {
    const noisy =
      '```\n' + Array(500).fill('word').join(' ') + '\n```\nrest text only';
    // Только «rest text only» — 3 слова — должен быть 1 минутой.
    expect(readingTime(noisy, 'en')).toBe(1);
  });

  it('WPM-таблица соответствует ADR-137', () => {
    expect(READING_WPM.ru).toBe(200);
    expect(READING_WPM.en).toBe(250);
  });
});
