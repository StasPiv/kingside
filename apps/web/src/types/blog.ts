/**
 * KS-4393 → KS-4394 / ADR-137 §3.1. Контракты блога Kingside.
 *
 * Источник истины — `apps/web/src/content/blog/<slug>.<locale>.md`
 * (frontmatter в YAML) + `apps/web/src/content/blog/_authors.json`.
 * Авто-генерируемый `generated/blog-index.ts` использует `BlogIndexEntry`,
 * рантайм-страницы (`/blog`, `/blog/:slug`) используют остальные типы.
 */
export type BlogLocale = 'ru' | 'en';

/** Полный набор языков, поддерживаемых блогом. Удобно для итерации. */
export const BLOG_LOCALES: readonly BlogLocale[] = ['ru', 'en'] as const;

/**
 * YAML-фронтматтер статьи. Обязательные поля валидируются на build-этапе
 * `vite-blog-plugin.mjs`; недостающие фейлят сборку — так UI всегда
 * получает консистентный объект.
 */
export interface BlogPostFrontmatter {
  title: string;
  description: string;
  slug: string;
  locale: BlogLocale;
  /** ISO date `YYYY-MM-DD`. */
  publishedAt: string;
  /** ISO date `YYYY-MM-DD`. Показывается в UI только если ≠ publishedAt. */
  updatedAt: string;
  /** Идентификатор из `_authors.json`. */
  author: string;
  tags: readonly string[];
  cover?: string;
  coverAlt?: string;
  /** Если задано — на странице статьи отрисовывается CTA-блок «Попробовать в разделе». */
  relatedRoute?: string;
  /** `true` → статья не попадает в индекс и в prerender/sitemap. */
  draft?: boolean;
}

/**
 * Запись в массиве `BLOG_INDEX` — фронтматтер + посчитанное на сборке
 * время чтения. Тело подгружается лениво через `loadBlogBody`.
 */
export interface BlogIndexEntry extends BlogPostFrontmatter {
  /** Минут чтения (200 wpm ru / 250 wpm en, минимум 1). */
  readingTimeMin: number;
}

/**
 * Модуль тела статьи (`apps/web/src/content/blog/<slug>.<locale>.md`),
 * который отдаёт `vite-blog-plugin`. `body` — HTML-строка готовая к
 * `dangerouslySetInnerHTML`; `default` совпадает с `body`.
 */
export interface BlogBodyModule {
  default: string;
  body: string;
  readingTimeMin: number;
  frontmatter: BlogIndexEntry;
}

/**
 * Полная статья — `BlogIndexEntry` + тело в HTML. Используется
 * страницей `/blog/:slug` после `await loadBlogBody(slug, locale)`.
 */
export interface BlogPost extends BlogIndexEntry {
  /** HTML, готовый к рендеру в `<article>` через `dangerouslySetInnerHTML`. */
  bodyHtml: string;
}

/**
 * Запись автора из `_authors.json`. RU/EN — отдельные поля, чтобы не
 * тянуть авторов через i18next-ресурсы (статья — в репо, авторы — в
 * репо, локализация рядом).
 */
export interface BlogAuthor {
  id: string;
  name: string;
  /** Если не задано — фронт использует `name` для EN тоже. */
  name_en?: string;
  avatar?: string;
  bio_ru?: string;
  bio_en?: string;
}

/**
 * Помощник: набор записей одного `slug` сгруппирован по локали. Используется
 * `filterByLocale` для разрешения «есть ли перевод».
 */
export type BlogIndexBySlug = ReadonlyMap<
  string,
  Partial<Record<BlogLocale, BlogIndexEntry>>
>;
