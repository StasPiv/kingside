/**
 * KS-4409 / ADR-137 rev2. Юнит-тесты helper'а Markdown → HTML +
 * базового sanitize.
 */
import { renderMarkdownToHtml } from './markdown';

describe('renderMarkdownToHtml', () => {
  it('заголовок и параграф', async () => {
    const html = await renderMarkdownToHtml('# Hello\n\nworld');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<p>world</p>');
  });

  it('удаляет <script>', async () => {
    const html = await renderMarkdownToHtml(
      'safe<script>alert(1)</script>tail',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert');
  });

  it('удаляет <iframe>', async () => {
    const html = await renderMarkdownToHtml(
      '<iframe src="https://evil"></iframe>',
    );
    expect(html).not.toContain('<iframe');
  });

  it('удаляет on*-атрибуты', async () => {
    const html = await renderMarkdownToHtml(
      '<a href="https://safe" onclick="evil()">x</a>',
    );
    expect(html).not.toMatch(/\sonclick=/i);
  });

  it('удаляет javascript: URL', async () => {
    const html = await renderMarkdownToHtml(
      '<a href="javascript:alert(1)">x</a>',
    );
    expect(html).not.toMatch(/href\s*=\s*"javascript:/i);
  });
});
