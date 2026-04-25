import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-1895 + KS-1905: smoke-тесты на страницу документации.
 *
 * Покрытие:
 *  - fetch + рендер h1/h2/таблицы/картинки/ToC (KS-1895);
 *  - SEO `document.title` + meta description ставятся под текущую
 *    локаль и переустанавливаются при смене языка (KS-1905);
 *  - выбор файла по `i18n.language`: ru → user-courses.md, en →
 *    user-courses.en.md (KS-1905);
 *  - fallback: 404 на en → silently fetch'нем ru и покажем banner
 *    «English version is not yet available» (KS-1905);
 *  - смена языка пере-fetch'ит markdown без перезагрузки страницы
 *    (KS-1905).
 */

const RU_MD = `# Документация

## 1. Обзор раздела

Текст обзора.

![Lessons list автора](./screenshots/lessons-list-author.png)

## 2. Роли

| Роль | Что видит |
|---|---|
| Гость | системные |
| Студент | системные + мои |
`;

const EN_MD = `# Documentation

## 1. Overview

English text.

## 2. Roles

| Role | What they see |
|---|---|
| Guest | system courses |
| Student | system + mine |
`;

// Управляемый i18n-mock — в каждом тесте задаём язык вручную.
const { i18nMock } = vi.hoisted(() => ({
  i18nMock: { language: 'ru' as 'ru' | 'en' },
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<object>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key,
      i18n: i18nMock,
    }),
  };
});

import { DocsUserCoursesPage } from './DocsUserCoursesPage';

function mockFetch({
  ru,
  en,
}: {
  ru?: { ok: true; body: string } | { ok: false; status: number };
  en?: { ok: true; body: string } | { ok: false; status: number };
}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('user-courses.en.md')) {
      if (en?.ok) return new Response(en.body, { status: 200 });
      return new Response('not found', { status: en?.status ?? 404 });
    }
    if (url.endsWith('user-courses.md')) {
      if (ru?.ok) return new Response(ru.body, { status: 200 });
      return new Response('not found', { status: ru?.status ?? 404 });
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => {
  i18nMock.language = 'ru';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<DocsUserCoursesPage> rendering (KS-1895 регрессия)', () => {
  it('загружает markdown и рендерит заголовок + h2-разделы', async () => {
    mockFetch({ ru: { ok: true, body: RU_MD } });
    renderWithProviders(<DocsUserCoursesPage />);
    expect(screen.getByTestId('docs-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Документация',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: /1\. Обзор раздела/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /2\. Роли/i }),
    ).toBeInTheDocument();
  });

  it('картинка из markdown получает src с baseUrl=/docs/user-courses/', async () => {
    mockFetch({ ru: { ok: true, body: RU_MD } });
    const { container } = renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      '/docs/user-courses/screenshots/lessons-list-author.png',
    );
  });

  it('таблица отрендерилась как <table>', async () => {
    mockFetch({ ru: { ok: true, body: RU_MD } });
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
    mockFetch({ ru: { ok: true, body: RU_MD } });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    const tocLinks = screen.getAllByRole('link');
    expect(
      tocLinks.some((l) => /1\. Обзор раздела/.test(l.textContent ?? '')),
    ).toBe(true);
  });

  it('error-state при 5xx', async () => {
    mockFetch({ ru: { ok: false, status: 500 } });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-error')).toBeInTheDocument(),
    );
  });
});

describe('<DocsUserCoursesPage> i18n (KS-1905)', () => {
  it('language=ru → fetch русского файла', async () => {
    i18nMock.language = 'ru';
    mockFetch({ ru: { ok: true, body: RU_MD } });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.md',
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.en.md',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Документация',
    );
    expect(screen.queryByTestId('docs-fallback-banner')).not.toBeInTheDocument();
  });

  it('language=en → fetch английского файла', async () => {
    i18nMock.language = 'en';
    mockFetch({
      ru: { ok: true, body: RU_MD },
      en: { ok: true, body: EN_MD },
    });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.en.md',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Documentation',
    );
    expect(screen.queryByTestId('docs-fallback-banner')).not.toBeInTheDocument();
  });

  it('language=en + EN-файл 404 → silently fetch ru + banner', async () => {
    i18nMock.language = 'en';
    mockFetch({
      ru: { ok: true, body: RU_MD },
      en: { ok: false, status: 404 },
    });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    // Сначала был запрос на en
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.en.md',
    );
    // Потом fallback на ru
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.md',
    );
    // Контент русский
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Документация',
    );
    // Banner виден
    expect(screen.getByTestId('docs-fallback-banner')).toBeInTheDocument();
  });

  it('SEO: title и meta description зависят от языка', async () => {
    i18nMock.language = 'ru';
    mockFetch({ ru: { ok: true, body: RU_MD } });
    const { unmount } = renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() => {
      expect(document.title).toBe('Мои курсы — Kingside');
    });
    expect(
      (
        document.querySelector(
          'meta[name="description"]',
        ) as HTMLMetaElement | null
      )?.content,
    ).toContain('Пользовательские курсы');
    unmount();

    i18nMock.language = 'en';
    mockFetch({ en: { ok: true, body: EN_MD } });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() => {
      expect(document.title).toBe('My Courses — Kingside');
    });
    expect(
      (
        document.querySelector(
          'meta[name="description"]',
        ) as HTMLMetaElement | null
      )?.content,
    ).toContain('User courses');
  });

  it('смена языка перезагружает контент без перезагрузки страницы', async () => {
    i18nMock.language = 'ru';
    mockFetch({
      ru: { ok: true, body: RU_MD },
      en: { ok: true, body: EN_MD },
    });
    const { rerender } = renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Документация',
      ),
    );

    // Меняем язык и форсим rerender компонента (в проде это сделает
    // react-i18next через subscribe на languageChanged).
    act(() => {
      i18nMock.language = 'en';
    });
    rerender(<DocsUserCoursesPage />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Documentation',
      ),
    );
  });

  it('language=en-US (region) → расценивается как en', async () => {
    i18nMock.language = 'en-US';
    mockFetch({ en: { ok: true, body: EN_MD } });
    renderWithProviders(<DocsUserCoursesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('docs-user-courses-page')).toBeInTheDocument(),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/docs/user-courses/user-courses.en.md',
    );
  });
});
