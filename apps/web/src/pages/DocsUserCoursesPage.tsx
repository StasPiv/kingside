import { useEffect, useMemo, useState } from 'react';

import { DocsMarkdown, extractH2Headings } from '../utils/docsMarkdown';

/**
 * `DocsUserCoursesPage` — публичная статическая страница документации
 * «Мои курсы» (KS-1895).
 *
 * Контент — markdown-файл, лежащий в `apps/web/public/docs/user-courses/
 * user-courses.md`. Страница его fetch'ит и рендерит через
 * `<DocsMarkdown>` (без зависимостей, см. `utils/docsMarkdown.tsx`).
 *
 * Маршрут — `/docs/user-courses`. Без `<ProtectedRoute>` — документация
 * читается и гостями.
 *
 * # Структура
 *
 * Один длинный одностраничник со sticky-ToC слева на десктопе. На
 * mobile ToC схлопывается в `<details>`-секцию сверху (всё ещё кликается
 * через якоря). 8 разделов + 2 приложения — обходимо за один скролл.
 *
 * # SEO
 *
 * Используем `document.title` и `meta description` через прямые
 * манипуляции в `useEffect` — `react-helmet-async` в проекте не
 * подключён, ставить ради одной страницы не оправдано.
 *
 * # i18n
 *
 * TODO: документ только на RU. EN-перевод — отдельная задача
 * (architect должен подготовить параллельный markdown). Переключатель
 * EN/RU в шапке остаётся, но контент этой страницы не переводится.
 */

const DOC_PATH = '/docs/user-courses/user-courses.md';
const BASE_URL = '/docs/user-courses/';
const PAGE_TITLE = 'Мои курсы — Kingside';
const PAGE_DESCRIPTION =
  'Пользовательские курсы на Kingside: создание собственных уроков, прохождение чужих публичных, метрики автора, ограничения.';

export function DocsUserCoursesPage() {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SEO
  useEffect(() => {
    const prevTitle = document.title;
    document.title = PAGE_TITLE;
    let descMeta = document.querySelector(
      'meta[name="description"]',
    ) as HTMLMetaElement | null;
    const created = !descMeta;
    if (!descMeta) {
      descMeta = document.createElement('meta');
      descMeta.name = 'description';
      document.head.appendChild(descMeta);
    }
    const prevContent = descMeta.content;
    descMeta.content = PAGE_DESCRIPTION;
    return () => {
      document.title = prevTitle;
      if (created && descMeta) descMeta.remove();
      else if (descMeta) descMeta.content = prevContent;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(DOC_PATH)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setSource(text);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Якорный скролл при first-load — браузер не доскроллит, потому что
  // содержимое появляется асинхронно после fetch.
  useEffect(() => {
    if (!source) return;
    const hash = window.location.hash;
    if (!hash) return;
    // Микро-задержка чтобы DOM успел дорендериться.
    const timer = setTimeout(() => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, 0);
    return () => clearTimeout(timer);
  }, [source]);

  // Чистый extract h2 из source — без двойных рендеров StrictMode'а
  // и без коллбэков в render-tree.
  const toc = useMemo(
    () => (source ? extractH2Headings(source) : []),
    [source],
  );

  if (error) {
    return (
      <div className="docs-page docs-page--error" data-testid="docs-error">
        <h1>Не удалось загрузить документацию</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (source === null) {
    return (
      <div className="docs-page" data-testid="docs-loading">
        Загрузка…
      </div>
    );
  }

  return (
    <div className="docs-page" data-testid="docs-user-courses-page">
      <aside className="docs-toc" aria-label="Содержание">
        <div className="docs-toc__inner">
          <h2 className="docs-toc__title">Содержание</h2>
          <ol className="docs-toc__list">
            {toc.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`}>{h.text}</a>
              </li>
            ))}
          </ol>
        </div>
      </aside>
      <article className="docs-article">
        <DocsMarkdown source={source} baseUrl={BASE_URL} />
      </article>
    </div>
  );
}
