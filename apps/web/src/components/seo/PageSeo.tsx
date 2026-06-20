/**
 * KS-4222 / ADR-128 §7.6.1. Тонкая обёртка над `<SeoHelmet>` для
 * статических публичных страниц, где title/description приходят
 * из i18n-ключей `seo.<ns>.title|description`, canonical — из path,
 * а og-image и тип задаются дефолтами.
 *
 * Использование:
 *
 *   <PageSeo ns="puzzles.list" path="/puzzles" />
 *
 *   <PageSeo
 *     ns="puzzles.detail"
 *     path={`/puzzle/${id}`}
 *     vars={{ id }}
 *     jsonLd={{ '@context': 'https://schema.org', '@type': 'WebApplication', ... }}
 *   />
 *
 * Для нестандартных кейсов (динамическое описание из данных,
 * Article/SportsEvent JSON-LD и т.п.) используйте `SeoHelmet` напрямую.
 */
import { useTranslation } from 'react-i18next';

import { SeoHelmet, type SeoHelmetHreflang } from './SeoHelmet';

const ORIGIN = 'https://kingside.site';

export interface PageSeoProps {
  /** Префикс i18n-ключей: `seo.<ns>.title`, `seo.<ns>.description`. */
  ns: string;
  /** Путь в продакшене — для canonical. Должен начинаться со `/`. */
  path: string;
  /** Переменные для i18n-шаблонов (`{{id}}`, `{{title}}` и т.п.). */
  vars?: Record<string, string | number>;
  /** Переопределить og:image (по умолчанию `/og/default.png`). */
  ogImage?: string;
  /** Переопределить og:type (по умолчанию `website`). */
  ogType?: 'website' | 'article' | 'event' | 'profile';
  /** Скрыть страницу из поисковой выдачи (личные стат-страницы). */
  noindex?: boolean;
  /** Опциональный JSON-LD (объект или массив объектов). */
  jsonLd?: object | object[];
  /**
   * KS-4460. Альтернативные языковые версии (`<link rel="alternate"
   * hreflang="..." href="...">`). Прокидывается без изменений в
   * `SeoHelmet`. Передаётся страницами, у которых каждая локаль имеет
   * собственный URL (например, блог: `/en/blog` и `/ru/blog`).
   */
  hreflang?: SeoHelmetHreflang[];
  /**
   * KS-4460. Язык страницы (атрибут `<html lang="...">`). Применяется
   * императивно через `document.documentElement.lang` (см. SeoHelmet).
   */
  lang?: string;
}

export function PageSeo({
  ns,
  path,
  vars,
  ogImage = '/og/default.png',
  ogType = 'website',
  noindex,
  jsonLd,
  hreflang,
  lang,
}: PageSeoProps) {
  const { t } = useTranslation();
  const title = t(`seo.${ns}.title`, vars);
  const description = t(`seo.${ns}.description`, vars);
  const canonical = `${ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
  return (
    <SeoHelmet
      title={title}
      description={description}
      canonical={canonical}
      ogType={ogType}
      ogImage={ogImage}
      noindex={noindex}
      jsonLd={jsonLd}
      hreflang={hreflang}
      lang={lang}
    />
  );
}
