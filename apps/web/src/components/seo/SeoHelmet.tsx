// KS-4175 / KS-4211 / ADR-128 §7.6.1.1.A: переиспользуемый SEO-компонент
// на нативных metadata-тегах React 19. С 19-й версии React сам поднимает
// `<title>`, `<meta>`, `<link>` из произвольного места дерева в `<head>`
// документа и обеспечивает дедупликацию по ключу тега (`name`/`property`/
// `rel`) — внешняя библиотека (react-helmet/-async) не нужна, провайдер
// тоже не нужен.
//
// Контракт пропсов — точная копия §7.6.1.1.A. Все опциональные поля
// имеют разумные дефолты (`ogType=website`, `twitterCard=summary_large_image`,
// `ogImage=/og/default.png`). `canonical`, если не передан, собирается из
// текущего URL без query/hash — для статических лендингов этого хватает,
// для динамических страниц всегда передавайте явно (фильтры в query не
// должны порождать дубли в индексе).
//
// `title` и `description` всегда прогоняются через `truncateByWord`
// (60 / 160 символов) — чтобы случайный длинный текст не уехал в SERP
// обрезанным посередине слова.
//
// Примеры использования (§7.6.1.2):
//
//   // Broadcast-турнир (article + JSON-LD SportsEvent):
//   <SeoHelmet
//     title={`${event.name} — Live broadcast`}
//     description={`Follow ${event.name} live with engine analysis on Kingside.`}
//     canonical={`https://kingside.site/broadcasts/${event.slug}`}
//     ogType="article"
//     ogImage={event.posterUrl ?? undefined}
//     hreflang={[
//       { lang: 'en', href: `https://kingside.site/broadcasts/${event.slug}` },
//       { lang: 'ru', href: `https://kingside.site/ru/broadcasts/${event.slug}` },
//     ]}
//     jsonLd={{ '@context': 'https://schema.org', '@type': 'SportsEvent', name: event.name }}
//   />
//
//   // Player profile (profile + Person):
//   <SeoHelmet
//     title={`${player.username} — chess profile`}
//     description={`Rating, games and puzzles by ${player.username} on Kingside.`}
//     canonical={`https://kingside.site/player/${player.username}`}
//     ogType="profile"
//     jsonLd={{ '@context': 'https://schema.org', '@type': 'Person', name: player.username }}
//   />
//
//   // Lecture landing (article + Course):
//   <SeoHelmet
//     title={`${lecture.title} — by ${coach}`}
//     description={lecture.description}
//     ogType="article"
//     ogImage="/og/lecture.png"
//     jsonLd={{ '@context': 'https://schema.org', '@type': 'Course', name: lecture.title }}
//   />

import { useEffect, useLayoutEffect } from 'react';
import { truncateByWord } from './truncate';

/**
 * KS-4211: селекторы, которые `<SeoHelmet>` добавляет в `<head>`.
 * Статически такие же теги объявлены в `apps/web/index.html` — React 19
 * нативные metadata-теги поднимают свои копии в `<head>`, но НЕ
 * удаляют оригиналы из исходного HTML. Без явной чистки в prerender'е
 * для одной страницы получается два `<meta property="og:title">` —
 * Telegram/Twitter боты в этом случае могут взять первый («Kingside
 * — Play Chess Online»), а не per-page. Дедупликатор оставляет
 * последний тег (React 19 добавляет последним) и удаляет более
 * ранние совпадения.
 */
const DEDUPE_SELECTORS = [
  'meta[name="description"]',
  'meta[name="robots"]',
  'meta[name="twitter:card"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:alt"]',
  'meta[name="twitter:site"]',
  'meta[property="og:type"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:image"]',
  'meta[property="og:image:alt"]',
  'meta[property="og:url"]',
  'meta[property="og:site_name"]',
  'link[rel="canonical"]',
] as const;

const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 160;
const DEFAULT_OG_IMAGE = '/og/default.png';
const SITE_NAME = 'Kingside';
const TWITTER_SITE = '@kingside_chess';

export interface SeoHelmetHreflang {
  /** Языковой код для атрибута `hreflang`, напр. `'en'`, `'ru'`, `'x-default'`. */
  lang: string;
  /** Абсолютный URL альтернативной версии страницы. */
  href: string;
}

export interface SeoHelmetProps {
  title: string;
  description: string;
  canonical?: string;
  ogType?: 'website' | 'article' | 'event' | 'profile';
  ogImage?: string;
  ogImageAlt?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  noindex?: boolean;
  /**
   * KS-4211: альтернативные языковые версии страницы. Каждый элемент
   * → `<link rel="alternate" hreflang="<lang>" href="<href>">`.
   * `x-default` поддерживается как любое другое значение `lang`.
   */
  hreflang?: SeoHelmetHreflang[];
  jsonLd?: object | object[];
  lang?: string;
}

function resolveCanonical(canonical: string | undefined): string | undefined {
  if (canonical) return canonical;
  if (typeof window === 'undefined') return undefined;
  return `${window.location.origin}${window.location.pathname}`;
}

export function SeoHelmet({
  title,
  description,
  canonical,
  ogType = 'website',
  ogImage = DEFAULT_OG_IMAGE,
  ogImageAlt,
  twitterCard = 'summary_large_image',
  noindex = false,
  hreflang,
  jsonLd,
  lang,
}: SeoHelmetProps) {
  const safeTitle = truncateByWord(title, TITLE_LIMIT);
  const safeDescription = truncateByWord(description, DESCRIPTION_LIMIT);
  const resolvedCanonical = resolveCanonical(canonical);

  // KS-4211: после того как React 19 поднял наши JSX-meta'ы в head,
  // удаляем дубликаты из исходного `index.html` (см. комментарий к
  // `DEDUPE_SELECTORS`). Используем useLayoutEffect — он выполняется
  // на том же фрейме сразу после commit, до браузерной paint'ы; это
  // даёт чистый head ещё до сериализации HTML в prerender'е (Playwright
  // делает полный hydrate, эффекты успевают сработать).
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    for (const selector of DEDUPE_SELECTORS) {
      const matches = document.head.querySelectorAll(selector);
      if (matches.length <= 1) continue;
      // React добавляет свои теги последними — оставляем последний,
      // более ранние (статические из index.html) удаляем.
      for (let i = 0; i < matches.length - 1; i++) {
        matches[i].remove();
      }
    }
  });

  // `lang` атрибут на корневом `<html>` React 19 в JSX не поднимает —
  // там это статический тег index.html. Меняем императивно через
  // document.documentElement.lang, откатываем на размонтировании.
  useEffect(() => {
    if (!lang || typeof document === 'undefined') return;
    const previous = document.documentElement.lang;
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = previous;
    };
  }, [lang]);

  const jsonLdString = jsonLd ? JSON.stringify(jsonLd) : null;

  return (
    <>
      <title>{safeTitle}</title>
      <meta name="description" content={safeDescription} />
      {resolvedCanonical && <link rel="canonical" href={resolvedCanonical} />}

      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={safeTitle} />
      <meta property="og:description" content={safeDescription} />
      <meta property="og:site_name" content={SITE_NAME} />
      {resolvedCanonical && <meta property="og:url" content={resolvedCanonical} />}
      <meta property="og:image" content={ogImage} />
      {ogImageAlt && <meta property="og:image:alt" content={ogImageAlt} />}

      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:site" content={TWITTER_SITE} />
      <meta name="twitter:title" content={safeTitle} />
      <meta name="twitter:description" content={safeDescription} />
      <meta name="twitter:image" content={ogImage} />
      {ogImageAlt && <meta name="twitter:image:alt" content={ogImageAlt} />}

      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {hreflang?.map((alt) => (
        <link
          key={`alt:${alt.lang}`}
          rel="alternate"
          hrefLang={alt.lang}
          href={alt.href}
        />
      ))}

      {jsonLdString && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdString }}
        />
      )}
    </>
  );
}
