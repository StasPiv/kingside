import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { DocsUserCoursesPage } from './DocsUserCoursesPage';

/**
 * KS-1895: smoke-тест на страницу документации.
 * Проверяем что fetch-ит markdown, рендерит h1, h2-разделы и
 * картинки с правильными src.
 */

const SAMPLE_MD = `# Документация

## 1. Обзор раздела

Текст обзора.

![Lessons list автора](./screenshots/lessons-list-author.png)

## 2. Роли

| Роль | Что видит |
|---|---|
| Гость | системные |
| Студент | системные + мои |
`;

describe('<DocsUserCoursesPage>', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('user-courses.md')) {
        return new Response(SAMPLE_MD, {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }
      return new Response('not found', { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('загружает markdown и рендерит заголовок + h2-разделы', async () => {
    renderWithProviders(<DocsUserCoursesPage />);
    expect(screen.getByTestId('docs-loading')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Документация',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: /1. Обзор раздела/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /2. Роли/i }),
    ).toBeInTheDocument();
  });

  it('картинка из markdown получает src с baseUrl=/docs/user-courses/', async () => {
    const { container } = renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      '/docs/user-courses/screenshots/lessons-list-author.png',
    );
    expect(img?.getAttribute('alt')).toBe('Lessons list автора');
  });

  it('таблица отрендерилась как <table>', async () => {
    const { container } = renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    const ths = container.querySelectorAll('th');
    expect(Array.from(ths).map((t) => t.textContent)).toEqual([
      'Роль',
      'Что видит',
    ]);
  });

  it('ToC содержит h2-разделы', async () => {
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    // ToC рендерится после async-сбора headings (microtask). Дождёмся.
    await waitFor(() => {
      const tocLinks = screen.getAllByRole('link');
      expect(tocLinks.some((l) => /1\. Обзор раздела/.test(l.textContent ?? ''))).toBe(true);
    });
  });

  it('SEO: document.title и meta description ставятся при mount', async () => {
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() => {
      expect(document.title).toBe('Мои курсы — Kingside');
    });
    const meta = document.querySelector(
      'meta[name="description"]',
    ) as HTMLMetaElement | null;
    expect(meta?.content).toContain('Пользовательские курсы');
  });

  it('error-state при 404', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 }),
    );
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-error')).toBeInTheDocument(),
    );
  });
});
