import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DocsMarkdown, extractH2Headings } from '../utils/docsMarkdown';

/**
 * `DocsUserCoursesPage` — публичная статическая страница документации
 * «Мои курсы» (KS-1895).
 *
 * Контент — markdown-файл, лежащий в `apps/web/public/docs/user-courses/`.
 * Страница его fetch'ит и рендерит через `<DocsMarkdown>` (без
 * зависимостей, см. `utils/docsMarkdown.tsx`).
 *
 * Маршрут — `/docs/user-courses`. Без `<ProtectedRoute>` — документация
 * читается и гостями.
 *
 * # Локализация (KS-1905)
 *
 * Файл выбирается по текущему языку i18next:
 *   - `i18n.language === 'en'` → `user-courses.en.md`
 *   - иначе                    → `user-courses.md` (русский, дефолт)
 *
 * Если запрошенный английский файл вернул 404 (английская версия ещё
 * не задеплоена — KS-1904 в работе), страница тихо перезапрашивает
 * русский и показывает ненавязчивый banner-уведомление. Это позволяет
 * выкатить локалевый switch до готовности EN-перевода без поломки UX.
 *
 * Переключатель EN/RU в шапке меняет `i18n.language` → useEffect
 * пересчитывает path и перезагружает markdown без перезагрузки
 * страницы.
 *
 * # Структура
 *
 * Один длинный одностраничник со sticky-ToC слева на десktop'е. На
 * mobile ToC схлопывается в обычный блок сверху (всё ещё кликается
 * через якоря).
 *
 * # SEO
 *
 * `document.title` и `meta description` ставятся через прямые
 * манипуляции DOM в `useEffect` (с восстановлением при unmount).
 * Также реагируют на смену языка — заголовок/описание тоже
 * локализуются. `react-helmet-async` в проекте не подключён, ставить
 * ради одной страницы не оправдано.
 */

const BASE_URL = '/docs/user-courses/';
const RU_PATH = '/docs/user-courses/user-courses.md';
const EN_PATH = '/docs/user-courses/user-courses.en.md';

const PAGE_META: Record<'ru' | 'en', { title: string; description: string }> = {
  ru: {
    title: 'Мои курсы — Kingside',
    description:
      'Пользовательские курсы на Kingside: создание собственных уроков, прохождение чужих публичных, метрики автора, ограничения.',
  },
  en: {
    title: 'My Courses — Kingside',
    description:
      'User courses on Kingside: build your own lessons, take other authors’ public courses, author metrics, current limitations.',
  },
};

const FALLBACK_BANNER: Record<'ru' | 'en', string> = {
  ru: '',
  en: 'English version is not yet available — showing Russian.',
};

const TOC_TITLE: Record<'ru' | 'en', string> = {
  ru: 'Содержание',
  en: 'Contents',
};

const LOADING_LABEL: Record<'ru' | 'en', string> = {
  ru: 'Загрузка…',
  en: 'Loading…',
};

const ERROR_TITLE: Record<'ru' | 'en', string> = {
  ru: 'Не удалось загрузить документацию',
  en: 'Failed to load the documentation',
};

function pickLang(raw: string): 'ru' | 'en' {
  return raw === 'en' || raw.startsWith('en-') ? 'en' : 'ru';
}

export function DocsUserCoursesPage() {
  const { i18n } = useTranslation();
  const lang = pickLang(i18n.language ?? 'ru');

  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fellBackToRu, setFellBackToRu] = useState(false);

  // SEO — переустанавливаем title/description при смене языка.
  useEffect(() => {
    const meta = PAGE_META[lang];
    const prevTitle = document.title;
    document.title = meta.title;
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
    descMeta.content = meta.description;
    return () => {
      document.title = prevTitle;
      if (created && descMeta) descMeta.remove();
      else if (descMeta) descMeta.content = prevContent;
    };
  }, [lang]);

  // Загрузка markdown — пересчитывается при смене языка.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSource(null);
    setFellBackToRu(false);

    const wantedPath = lang === 'en' ? EN_PATH : RU_PATH;

    fetch(wantedPath)
      .then(async (res) => {
        if (res.ok) {
          const text = await res.text();
          return { text, fellBack: false };
        }
        // 404 на en → тихий фоллбек на ru, чтобы страница не падала
        // пока английская версия не задеплоена (KS-1904).
        if (lang === 'en' && res.status === 404) {
          const ruRes = await fetch(RU_PATH);
          if (!ruRes.ok) throw new Error(`HTTP ${ruRes.status}`);
          const text = await ruRes.text();
          return { text, fellBack: true };
        }
        throw new Error(`HTTP ${res.status}`);
      })
      .then(({ text, fellBack }) => {
        if (cancelled) return;
        setSource(text);
        setFellBackToRu(fellBack);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [lang]);

  // Якорный скролл при first-load — браузер не доскроллит, потому что
  // содержимое появляется асинхронно после fetch.
  useEffect(() => {
    if (!source) return;
    const hash = window.location.hash;
    if (!hash) return;
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
        <h1>{ERROR_TITLE[lang]}</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (source === null) {
    return (
      <div className="docs-page" data-testid="docs-loading">
        {LOADING_LABEL[lang]}
      </div>
    );
  }

  return (
    <div className="docs-page" data-testid="docs-user-courses-page">
      <aside className="docs-toc" aria-label={TOC_TITLE[lang]}>
        <div className="docs-toc__inner">
          <h2 className="docs-toc__title">{TOC_TITLE[lang]}</h2>
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
        {fellBackToRu && (
          <div
            className="docs-fallback-banner"
            data-testid="docs-fallback-banner"
            role="status"
          >
            {FALLBACK_BANNER.en}
          </div>
        )}
        <DocsMarkdown source={source} baseUrl={BASE_URL} />
      </article>
    </div>
  );
}
