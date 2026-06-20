/**
 * KS-4398 / ADR-137 §2.4 T4. SEO-обёртка для страницы блога.
 *
 * `<PageSeo>` не подходит как есть — i18n-ключи у статьи не статичны
 * (их «ключ» — `slug` из frontmatter). Этот компонент берёт title /
 * description / og-image из `BlogIndexEntry`, собирает абсолютный
 * canonical (`https://kingside.site/blog/<slug>`, без локали — ADR-137
 * §2.4), hreflang-теги для всех доступных переводов и Article JSON-LD.
 */
import { SeoHelmet } from './SeoHelmet';
import type { BlogIndexEntry, BlogLocale } from '../../types/blog';

const ORIGIN = 'https://kingside.site';
const DEFAULT_COVER = '/og/blog-default.png';

export interface BlogPostSeoProps {
  post: BlogIndexEntry;
  /**
   * Локали, на которых статья реально опубликована. Для них
   * добавляются `<link rel="alternate" hreflang>`.
   */
  availableLocales: readonly BlogLocale[];
  /**
   * Имя автора для JSON-LD. Берётся из `_authors.json` по
   * `post.author` через адаптер на странице — здесь принимаем уже
   * разрешённое имя, чтобы компонент не лез в JSON-файл.
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
  const ogImage = absoluteUrl(post.cover ?? DEFAULT_COVER);
  const ogImageAlt = post.coverAlt ?? post.title;

  // hreflang: одна и та же URL'а — разные языковые «полки» одного и
  // того же контента (ADR-137 §2.4). Добавляем x-default для роботов,
  // которым нужно поведение «без региональной привязки».
  const hreflang =
    availableLocales.length > 0
      ? [
          ...availableLocales.map((l) => ({
            lang: l,
            href: canonical,
          })),
          { lang: 'x-default', href: canonical },
        ]
      : undefined;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
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
