/**
 * KS-4398 → KS-4414 → KS-4434 → KS-4460 / ADR-137 rev2. SEO-обёртка
 * для страницы блога.
 *
 * Источник полей — `BlogPostDetail` из `@kingside/shared` (бэкенд-API),
 * не локальный markdown-индекс.
 *
 * KS-4460: канонический URL содержит языковой префикс
 * (`https://kingside.site/<lang>/blog/<slug>`) — у каждой локали свой
 * URL, дубликатов в индексе нет. Альтернативные языковые версии
 * объявляются через `<link rel="alternate" hreflang="...">` для всех
 * поддерживаемых локалей + `x-default` → дефолтная локаль (см.
 * `DEFAULT_BLOG_LOCALE`).
 *
 * Раньше (KS-4434) hreflang со страницы был убран, потому что URL был
 * один общий и теги дублировали `canonical` — теперь, после переезда
 * на префикс языка, hreflang снова имеет смысл.
 *
 * JSON-LD Article — `headline`/`description`/`datePublished`/
 * `dateModified`/`image`/`author` из API-полей. Имя автора передаётся
 * уже разрешённое по локали (`nameRu`/`nameEn`).
 */
import { SeoHelmet } from './SeoHelmet';
import {
  BLOG_LOCALES,
  DEFAULT_BLOG_LOCALE,
  blogPostPath,
} from '../../utils/blogUrl';
import type { BlogLocale, BlogPostDetail } from '@kingside/shared';

const ORIGIN = 'https://kingside.site';
// KS-4438: fallback для og:image — общий `/og/default.png` (он реально
// лежит в `public/og/`). Прежний `/og/blog-default.png` отсутствовал;
// социальные превью без `og:image` выглядят хуже, чем с обобщённой
// заглушкой бренда, поэтому используем именно существующий файл.
const DEFAULT_COVER = '/og/default.png';

export interface BlogPostSeoProps {
  post: BlogPostDetail;
  /**
   * Имя автора для JSON-LD. Передаём уже разрешённое по локали
   * (`nameRu`/`nameEn`), чтобы компонент не повторял эту логику.
   */
  authorName: string;
  /**
   * KS-4460. Локаль страницы, на которой пользователь сейчас находится
   * (из URL `/:lang/blog/:slug`). Может отличаться от `post.locale` —
   * если у статьи нет перевода, backend ставит `isLocaleFallback=true`
   * и возвращает поля английской версии, но canonical всё равно должен
   * указывать на запрошенный пользователем URL (`/ru/blog/<slug>`), а
   * не на источник fallback'а.
   */
  pageLocale: BlogLocale;
}

function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

export function BlogPostSeo({
  post,
  authorName,
  pageLocale,
}: BlogPostSeoProps) {
  // KS-4460. Canonical — на конкретную языковую версию страницы; не
  // на `post.locale` (fallback-источник), а на ту локаль, по URL
  // которой пользователь пришёл. Это совпадает с тем, что напишет
  // sitemap (см. `sitemap-build.mjs`) и что снимет prerender.
  const canonical = `${ORIGIN}${blogPostPath(pageLocale, post.slug)}`;
  // KS-4460. hreflang: по одной ссылке на каждую поддерживаемую локаль
  // + `x-default` → дефолтная локаль (рекомендация Google Search Central
  // для multi-language страниц с разными URL'ами). Локали известны на
  // фронте — если у статьи нет перевода, backend всё равно отдаст
  // fallback при заходе на `/<lang>/blog/<slug>`, поэтому каждая
  // hreflang-ссылка валидна.
  const hreflang = [
    ...BLOG_LOCALES.map((loc) => ({
      lang: loc,
      href: `${ORIGIN}${blogPostPath(loc, post.slug)}`,
    })),
    {
      lang: 'x-default',
      href: `${ORIGIN}${blogPostPath(DEFAULT_BLOG_LOCALE, post.slug)}`,
    },
  ];
  const ogImage = absoluteUrl(post.coverUrl ?? DEFAULT_COVER);
  const ogImageAlt = post.coverAlt ?? post.title;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    // ISO-8601. publishedAt у черновиков null — на публичной странице
    // мы такие не показываем, но защищаемся явной проверкой.
    ...(post.publishedAt ? { datePublished: post.publishedAt } : {}),
    dateModified: post.updatedAt,
    inLanguage: post.locale,
    keywords: [...post.tags],
    image: ogImage,
    author: {
      '@type': 'Organization',
      name: authorName,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Kingside',
      logo: {
        '@type': 'ImageObject',
        url: `${ORIGIN}/og/default.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonical,
    },
  };

  return (
    <SeoHelmet
      title={post.title}
      description={post.description}
      canonical={canonical}
      ogType="article"
      ogImage={ogImage}
      ogImageAlt={ogImageAlt}
      twitterCard="summary_large_image"
      jsonLd={jsonLd}
      hreflang={hreflang}
      // KS-4460. `<html lang>` ставим в `pageLocale`, а не в `post.locale`,
      // — у fallback-страниц иначе будет противоречие: URL `/ru/...`,
      // canonical `/ru/...`, hreflang включает `ru`, но `<html lang>="en"`.
      // Чтение `aria`/Google-парсера и так противоречие, понятнее
      // согласовать всё с `pageLocale`.
      lang={pageLocale}
    />
  );
}
