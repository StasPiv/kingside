/**
 * KS-4398 → KS-4414 → KS-4434 / ADR-137 rev2. SEO-обёртка для страницы
 * блога.
 *
 * Источник полей — `BlogPostDetail` из `@kingside/shared` (бэкенд-API),
 * не локальный markdown-индекс. Canonical для всех локалей одинаков:
 * `https://kingside.site/blog/<slug>` — locale выбирается рантаймом
 * (ADR-137 §2.4).
 *
 * KS-4434: hreflang со страницы статьи убран. Один URL для обеих
 * локалей, переключение через i18n внутри SPA; альтернативные адреса
 * мы не публикуем — давать `<link rel="alternate" hreflang="ru" href="...">`
 * на тот же URL бессмысленно (раньше так и было: все три варианта
 * указывали на одну и ту же страницу). Если в будущем появятся
 * локализованные URL — вернём пропсом и снова выставим теги.
 *
 * JSON-LD Article — `headline`/`description`/`datePublished`/
 * `dateModified`/`image`/`author` из API-полей. Имя автора передаётся
 * уже разрешённое по локали (`nameRu`/`nameEn`).
 */
import { SeoHelmet } from './SeoHelmet';
import type { BlogPostDetail } from '@kingside/shared';

const ORIGIN = 'https://kingside.site';
const DEFAULT_COVER = '/og/blog-default.png';

export interface BlogPostSeoProps {
  post: BlogPostDetail;
  /**
   * Имя автора для JSON-LD. Передаём уже разрешённое по локали
   * (`nameRu`/`nameEn`), чтобы компонент не повторял эту логику.
   */
  authorName: string;
}

function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

export function BlogPostSeo({ post, authorName }: BlogPostSeoProps) {
  const canonical = `${ORIGIN}/blog/${post.slug}`;
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
      lang={post.locale}
    />
  );
}
