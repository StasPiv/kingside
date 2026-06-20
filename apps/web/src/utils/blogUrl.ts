/**
 * KS-4460. Хелперы для URL'ов блога с префиксом языка.
 *
 * Контракт URL: `/<lang>/blog[/<slug>]`, где `<lang>` ∈
 * {@link BLOG_LOCALES}. Без префикса (`/blog`, `/blog/:slug`) маршрут
 * редиректит на {@link DEFAULT_BLOG_LOCALE} (см. App.tsx).
 *
 * Источник правды по `BlogLocale` — `packages/shared`. Расширение
 * списка локалей (uk/be/...): добавить значение в `BlogLocale` (shared)
 * и продублировать в `BLOG_LOCALES` ниже — этот файл намеренно
 * фиксирует упорядоченный список для рендера hreflang/sitemap, чтобы
 * порядок и состав ссылок не зависели от перечисления типа.
 */
import type { BlogLocale } from '@kingside/shared';

/**
 * Все поддерживаемые языки блога. Порядок фиксирован — он же используется
 * для генерации `<link rel="alternate" hreflang="...">` и для sitemap.
 */
export const BLOG_LOCALES: readonly BlogLocale[] = ['en', 'ru'] as const;

/**
 * Язык по умолчанию для редиректа со старых `/blog[/<slug>]` URL'ов и
 * для `hreflang="x-default"`. Выбран `en` как основной SEO-язык: он же
 * стоит первым в {@link BLOG_LOCALES}, статьи без `ru`-перевода уже сейчас
 * отдают английский fallback (см. `isLocaleFallback` в `BlogPostDetail`).
 */
export const DEFAULT_BLOG_LOCALE: BlogLocale = 'en';

/** Тип-гард: строка — поддерживаемая локаль блога. */
export function isBlogLocale(value: string | undefined): value is BlogLocale {
  return value === 'en' || value === 'ru';
}

/**
 * Нормализация произвольного значения (например, `i18n.language`,
 * `navigator.language`) в `BlogLocale`. Незнакомые языки → дефолт.
 */
export function toBlogLocale(value: string | undefined | null): BlogLocale {
  if (value && isBlogLocale(value)) return value;
  // Поддержка региональных кодов: `ru-RU`, `en-GB` → базовая часть.
  if (value) {
    const base = value.split('-')[0];
    if (isBlogLocale(base)) return base;
  }
  return DEFAULT_BLOG_LOCALE;
}

/** Путь к ленте блога на указанном языке. Без хэша/query. */
export function blogFeedPath(locale: BlogLocale): string {
  return `/${locale}/blog`;
}

/** Путь к конкретной статье на указанном языке. */
export function blogPostPath(locale: BlogLocale, slug: string): string {
  return `/${locale}/blog/${slug}`;
}
