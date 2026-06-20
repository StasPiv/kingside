/**
 * KS-4398 → KS-4414 / ADR-137 rev2 T8. SEO-обёртка для страницы блога.
 *
 * Источник полей — `BlogPostDetail` из `@kingside/shared` (бэкенд-API),
 * не локальный markdown-индекс. Canonical для всех локалей одинаков:
 * `https://kingside.site/blog/<slug>` — locale выбирается рантаймом
 * (ADR-137 §2.4).
 *
 * hreflang генерится только при наличии явного списка локалей у статьи
 * (передаётся пропсом). Backend сейчас не отдаёт `alternateLocales` —
 * на стороне страницы передаём `undefined`, и теги не добавляются.
 *
 * JSON-LD Article — `headline`/`description`/`datePublished`/
 * `dateModified`/`image`/`author` из API-полей. Если у автора есть
 * `nameRu`/`nameEn`, страница передаёт уже разрешённое имя пропсом.
 */
import { SeoHelmet } from './SeoHelmet';
import type { BlogLocale, BlogPostDetail } from '@kingside/shared';

const ORIGIN = 'https://kingside.site';
const DEFAULT_COVER = '/og/blog-default.png';

export interface BlogPostSeoProps {
  post: BlogPostDetail;
  /**
   * Локали, на которых статья реально опубликована. Для них
   * добавляются `<link rel="alternate" hreflang>`. Если не указано —
   * hreflang-теги не выставляются.
   */
  availableLocales?: readonly BlogLocale[];
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

export function BlogPostSeo({
  post,
  availableLocales,
  authorName,
}: BlogPostSeoProps) {
  const canonical = `${ORIGIN}/blog/${post.slug}`;
  const ogImage = absoluteUrl(post.coverUrl ?? DEFAULT_COVER);
  const ogImageAlt = post.coverAlt ?? post.title;

  const hreflang =
    availableLocales && availableLocales.length > 0
      ? [
          ...availableLocales.map((l) => ({ lang: l, href: canonical })),
          { lang: 'x-default', href: canonical },
        ]
      : undefined;

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
      hreflang={hreflang}
      jsonLd={jsonLd}
      lang={post.locale}
    />
  );
}
