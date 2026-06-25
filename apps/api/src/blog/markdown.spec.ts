/**
 * KS-4410 / ADR-137 rev2 + KS-4637. Юнит-тесты чистых helper'ов
 * `markdown.ts`. Полный pipeline `renderMarkdownToHtml` использует
 * ESM-only пакеты `unified`/`remark`/`rehype-sanitize` — jest CommonJS
 * не грузит их через dynamic `import()` без `--experimental-vm-modules`
 * (см. комментарий в `markdown.ts`). Поэтому здесь тестируем чистые
 * функции; поведение sanitize и YouTube-embed pipeline'а проверяется
 * на проде после деплоя + поэтапно через testbed-страницу
 * `/blog/<post-with-video>`.
 */
import {
  estimateReadingTimeMin,
  extractYoutubeVideoId,
  buildYoutubeIframeProperties,
} from './markdown';

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

describe('KS-4637: extractYoutubeVideoId', () => {
  const VALID_ID = 'dQw4w9WgXcQ';

  describe('принимает все поддержанные форматы YouTube-URL', () => {
    it.each([
      [`https://www.youtube.com/watch?v=${VALID_ID}`],
      [`https://youtube.com/watch?v=${VALID_ID}`],
      [`https://m.youtube.com/watch?v=${VALID_ID}`],
      [`https://www.youtube.com/watch?v=${VALID_ID}&t=42s`],
      [`https://youtu.be/${VALID_ID}`],
      [`https://www.youtube.com/embed/${VALID_ID}`],
      [`https://www.youtube.com/shorts/${VALID_ID}`],
      [`https://www.youtube.com/v/${VALID_ID}`],
      [`https://www.youtube-nocookie.com/embed/${VALID_ID}`],
    ])('%s → videoId', (url) => {
      expect(extractYoutubeVideoId(url)).toBe(VALID_ID);
    });
  });

  describe('отбрасывает невалидные / небезопасные URL', () => {
    const NOT_YOUTUBE = [
      // Нет схемы / битый URL.
      'not-a-url',
      '',
      'javascript:alert(1)',
      // http — не https, режем (трекеры, мог быть downgrade).
      `http://www.youtube.com/watch?v=${VALID_ID}`,
      // Чужой хост, мимикрирующий под YouTube.
      `https://evil.com/watch?v=${VALID_ID}`,
      `https://youtube.com.evil.com/watch?v=${VALID_ID}`,
      `https://www.youtube.com.evil.com/watch?v=${VALID_ID}`,
      // path traversal в embed-форме.
      `https://www.youtube.com/embed/../../etc/passwd`,
      // videoId неправильной длины / с недопустимыми символами.
      `https://www.youtube.com/watch?v=short`,
      `https://www.youtube.com/watch?v=${VALID_ID}EXTRA`,
      `https://youtu.be/with spaces`,
      // watch без v=.
      'https://www.youtube.com/watch',
      // playlist-only URL — без v=.
      'https://www.youtube.com/watch?list=PLabc',
    ];
    it.each(NOT_YOUTUBE.map((u) => [u]))('%s → null', (url) => {
      expect(extractYoutubeVideoId(url)).toBeNull();
    });
  });

  it('youtu.be: trailing slash вокруг id допустим', () => {
    // ровно один слэш — корень pathname, replace ^/ срабатывает.
    expect(extractYoutubeVideoId(`https://youtu.be/${VALID_ID}`)).toBe(VALID_ID);
  });

  it('embed: trailing slash допустим', () => {
    expect(
      extractYoutubeVideoId(`https://www.youtube.com/embed/${VALID_ID}/`),
    ).toBe(VALID_ID);
  });

  it('embed-URL с query (start/autoplay) → id экстрактится, query отбрасывается', () => {
    // query на оригинальной ссылке (часто `?start=10&autoplay=1`)
    // безопасно отбрасывается: наш iframe строится по фиксированному
    // шаблону, на выходе всегда `…/embed/<id>` без параметров.
    expect(
      extractYoutubeVideoId(
        `https://www.youtube.com/embed/${VALID_ID}?autoplay=1&start=10`,
      ),
    ).toBe(VALID_ID);
  });
});

describe('KS-4637: buildYoutubeIframeProperties', () => {
  const VALID_ID = 'dQw4w9WgXcQ';

  it('возвращает фиксированный набор полей с https-nocookie src', () => {
    const props = buildYoutubeIframeProperties(VALID_ID);
    expect(props.src).toBe(
      `https://www.youtube-nocookie.com/embed/${VALID_ID}`,
    );
    expect(props.title).toBe('YouTube video player');
    expect(props.frameBorder).toBe('0');
    expect(props.loading).toBe('lazy');
    expect(props.allowFullScreen).toBe(true);
    expect(props.referrerPolicy).toBe('strict-origin-when-cross-origin');
    // Точное значение allow важно — sanitize-схема пропускает только
    // эту строку буквально. Любое отклонение должно сломать тест.
    expect(props.allow).toBe(
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    );
  });

  it('бракует невалидный videoId (защита от прямых вызовов с мусором)', () => {
    expect(() =>
      buildYoutubeIframeProperties('not-a-valid-id-at-all'),
    ).toThrow(/invalid videoId/);
    expect(() => buildYoutubeIframeProperties('')).toThrow(/invalid videoId/);
    expect(() => buildYoutubeIframeProperties('short')).toThrow(
      /invalid videoId/,
    );
  });
});
