// KS-4175 / ADR-128 §7.6.1.1.A: переиспользуемый SEO-компонент на
// нативных metadata-тегах React 19. С 19-й версии React сам поднимает
// `<title>`, `<meta>`, `<link>` из произвольного места дерева в
// `<head>` документа и обеспечивает дедупликацию по ключу тега
// (`name`/`property`/`rel`). Внешняя библиотека (react-helmet/-async)
// не нужна, провайдер не нужен.
//
// Контракт пропсов — точная копия §7.6.1.1.A. Все опциональные поля
// имеют разумные дефолты (`ogType=website`, `twitterCard=summary_large_image`,
// `ogImage=/og/default.png`). canonical, если не передан, собирается из
// текущего URL без query/hash — для статических лендингов этого хватает,
// для динамических страниц всегда передавайте явно (фильтры в query не
// должны порождать дубли в индексе).
//
// `title` и `description` всегда прогоняются через `truncateByWord`
// (60 / 160 символов) — чтобы случайный длинный текст не уехал в SERP
// обрезанным посередине слова.

import { useEffect } from 'react';
import { truncateByWord } from './truncate';

const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 160;
const DEFAULT_OG_IMAGE = '/og/default.png';

export interface SeoHelmetProps {
  title: string;
  description: string;
  canonical?: string;
  ogType?: 'website' | 'article' | 'event' | 'profile';
  ogImage?: string;
  ogImageAlt?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  noindex?: boolean;
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
  jsonLd,
  lang,
}: SeoHelmetProps) {
  const safeTitle = truncateByWord(title, TITLE_LIMIT);
  const safeDescription = truncateByWord(description, DESCRIPTION_LIMIT);
  const resolvedCanonical = resolveCanonical(canonical);

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
      {resolvedCanonical && <meta property="og:url" content={resolvedCanonical} />}
      <meta property="og:image" content={ogImage} />
      {ogImageAlt && <meta property="og:image:alt" content={ogImageAlt} />}

      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={safeTitle} />
      <meta name="twitter:description" content={safeDescription} />
      <meta name="twitter:image" content={ogImage} />
      {ogImageAlt && <meta name="twitter:image:alt" content={ogImageAlt} />}

      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {jsonLdString && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdString }}
        />
      )}
    </>
  );
}
