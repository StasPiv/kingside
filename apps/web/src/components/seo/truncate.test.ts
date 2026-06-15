// KS-4175: проверки граничных случаев `truncateByWord`. Лимиты SEO
// (60 для title, 160 для description) — на этих величинах поведение
// должно быть стабильным: не рвать слово, не выдавать лишних пробелов,
// учитывать «…» в общей длине.

import { describe, it, expect } from 'vitest';
import { truncateByWord } from './truncate';

describe('truncateByWord', () => {
  it('возвращает исходную строку, если она короче лимита', () => {
    expect(truncateByWord('hello world', 60)).toBe('hello world');
  });

  it('возвращает строку как есть, если её длина точно равна лимиту', () => {
    const str = 'a'.repeat(60);
    expect(truncateByWord(str, 60)).toBe(str);
  });

  it('обрезает по последнему пробелу и добавляет «…»', () => {
    const input = 'The quick brown fox jumps over the lazy dog';
    const result = truncateByWord(input, 20);
    // Должна остановиться на границе слова, не разорвать «brown»
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe('The quick brown…');
  });

  it('не оставляет хвостовых пробелов перед «…»', () => {
    const input = 'foo                              bar';
    const result = truncateByWord(input, 10);
    expect(result).not.toMatch(/ …$/);
  });

  it('режет посимвольно, если в пределах лимита нет пробелов', () => {
    const input = 'supercalifragilisticexpialidocious';
    const result = truncateByWord(input, 10);
    expect(result).toBe('supercali…');
    expect(result).toHaveLength(10);
  });

  it('пустая строка возвращается без изменений', () => {
    expect(truncateByWord('', 60)).toBe('');
  });

  it('обрабатывает лимит ≤ 1', () => {
    expect(truncateByWord('abc', 1)).toBe('a');
    expect(truncateByWord('abc', 0)).toBe('');
  });

  it('реальный SEO-лимит description (160) — обрезает длинный текст по слову', () => {
    const long =
      'Шахматная платформа Kingside предлагает игру против живых соперников, ' +
      'разбор партий мощным движком Stockfish 18, тысячи тактических задач из ' +
      'базы Lichess, режим Puzzle Rush с лидербордами и онлайн-трансляции турниров.';
    const result = truncateByWord(long, 160);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith('…')).toBe(true);
    // Последнее слово целое, не оборвано
    const lastWord = result.slice(0, -1).trim().split(/\s+/).pop() ?? '';
    expect(long).toContain(lastWord);
  });
});
