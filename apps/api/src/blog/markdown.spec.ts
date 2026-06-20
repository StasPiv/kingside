/**
 * KS-4410 / ADR-137 rev2. Юнит-тесты `estimateReadingTimeMin`.
 *
 * `renderMarkdownToHtml` сейчас построен на ESM-only пакетах
 * `unified`/`remark`/`rehype-sanitize`. Jest CommonJS не может их
 * подгрузить через dynamic `import()` без `--experimental-vm-modules`;
 * добавлять флаг в общий jest-конфиг — рискованно (затронет все
 * существующие тесты). Поведение helper'а проверяется на проде
 * после деплоя; здесь покрываем только чистую часть про время чтения.
 */
import { estimateReadingTimeMin } from './markdown';

describe('estimateReadingTimeMin', () => {
  it('пустая строка → 1 (минимум для UI)', () => {
    expect(estimateReadingTimeMin('')).toBe(1);
  });

  it('один абзац ≤ 250 слов → 1', () => {
    const md = 'один два три '.repeat(50); // 150 слов
    expect(estimateReadingTimeMin(md)).toBe(1);
  });

  it('300 слов → 2 (250 в минуту, округление вверх)', () => {
    const md = 'один два три '.repeat(100); // 300 слов
    expect(estimateReadingTimeMin(md)).toBe(2);
  });

  it('markdown-разметка не считается за слова', () => {
    const md = '# Заголовок\n\n**жирный** *курсив* `код` [link](url)';
    // 5 содержательных слов → 1 минута.
    expect(estimateReadingTimeMin(md)).toBe(1);
  });
});
