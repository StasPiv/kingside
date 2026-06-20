/**
 * KS-4393 / ADR-137 T1. Минимальный набор типов блога — нужен для
 * компиляции автогенерированного `generated/blog-index.ts`. Полный
 * контракт (`BlogPost`, `BlogAuthor`, утилиты locale-fallback и т.п.)
 * вынесен на T2 (отдельная задача) — этот файл намеренно покрывает
 * только то, что использует индекс.
 */
export type BlogLocale = 'ru' | 'en';

export interface BlogPostFrontmatter {
  title: string;
  description: string;
  slug: string;
  locale: BlogLocale;
  /** ISO date `YYYY-MM-DD`. */
  publishedAt: string;
  updatedAt: string;
  author: string;
  tags: readonly string[];
  cover?: string;
  coverAlt?: string;
  relatedRoute?: string;
  draft?: boolean;
}

export interface BlogIndexEntry extends BlogPostFrontmatter {
  /** Минут чтения, build-computed (200 wpm ru / 250 wpm en). */
  readingTimeMin: number;
}
