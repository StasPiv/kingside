/**
 * KS-4411 / ADR-137 rev2. Юнит-тесты чистых хелперов сидера.
 */
import {
  isSkip,
  parseMarkdownContent,
  slugFromFilename,
} from './seed-helpers';

describe('slugFromFilename', () => {
  it('убирает префикс ^\\d+-', () => {
    expect(slugFromFilename('01-analysis.md')).toBe('analysis');
  });
  it('extension убирается', () => {
    expect(slugFromFilename('post.md')).toBe('post');
  });
  it('snake_case → kebab', () => {
    expect(slugFromFilename('my_first_post.md')).toBe('my-first-post');
  });
  it('пробелы/символы → дефис', () => {
    expect(slugFromFilename('Hello World!.md')).toBe('hello-world');
  });
});

describe('parseMarkdownContent', () => {
  it('frontmatter с title → используется', () => {
    const r = parseMarkdownContent(
      '---\ntitle: "Hi"\n---\n\ntext body',
      '/p/post.md',
    );
    expect(isSkip(r)).toBe(false);
    if (isSkip(r)) return;
    expect(r.title).toBe('Hi');
    expect(r.slug).toBe('post');
    expect(r.locale).toBe('ru');
    expect(r.status).toBe('published');
    expect(r.authorHandle).toBe('kingside');
  });

  it('title из H1 если нет в frontmatter', () => {
    const r = parseMarkdownContent('# Hello\n\nbody', '/p/01-hello.md');
    if (isSkip(r)) throw new Error('skipped: ' + r.reason);
    expect(r.title).toBe('Hello');
    expect(r.slug).toBe('hello');
  });

  it('description из первого параграфа', () => {
    const r = parseMarkdownContent(
      '# Title\n\nFirst paragraph here.\n\nSecond paragraph.',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped: ' + r.reason);
    expect(r.description).toBe('First paragraph here.');
  });

  it('frontmatter status=draft', () => {
    const r = parseMarkdownContent(
      '---\ntitle: t\nstatus: draft\n---\nbody',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped');
    expect(r.status).toBe('draft');
  });

  it('locale=en', () => {
    const r = parseMarkdownContent(
      '---\ntitle: t\nlocale: en\n---\nbody',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped');
    expect(r.locale).toBe('en');
  });

  it('tags массив', () => {
    const r = parseMarkdownContent(
      '---\ntitle: t\ntags: [a, b, c]\n---\nbody',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped');
    expect(r.tags).toEqual(['a', 'b', 'c']);
  });

  it('пустой body → skip', () => {
    const r = parseMarkdownContent('---\ntitle: t\n---\n', '/p/x.md');
    expect(isSkip(r)).toBe(true);
    if (!isSkip(r)) return;
    expect(r.reason).toMatch(/empty body/);
  });

  it('нет title (ни в FM, ни в H1) → skip', () => {
    const r = parseMarkdownContent('body without heading', '/p/x.md');
    expect(isSkip(r)).toBe(true);
    if (!isSkip(r)) return;
    expect(r.reason).toMatch(/missing title/);
  });

  it('frontmatter author override', () => {
    const r = parseMarkdownContent(
      '---\ntitle: t\nauthor: alice\n---\nbody',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped');
    expect(r.authorHandle).toBe('alice');
  });

  it('publishedAt из frontmatter', () => {
    const r = parseMarkdownContent(
      '---\ntitle: t\npublishedAt: "2026-01-15"\n---\nbody',
      '/p/x.md',
    );
    if (isSkip(r)) throw new Error('skipped');
    expect(r.publishedAt).toBe('2026-01-15');
  });
});
