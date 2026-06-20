/**
 * KS-4394 / ADR-137 T2. Публичный фасад утилит блога.
 *
 * Страницы (`/blog`, `/blog/:slug`) и компоненты импортируют отсюда,
 * не лезут в `generated/blog-index.ts` напрямую — это уменьшает
 * вероятность того, что UI сломается, если структура автогенерации
 * изменится в будущем.
 */
export { readingTime, stripMarkdown, countWords, READING_WPM } from './readingTime';
export {
  filterByLocale,
  type BlogListEntry,
  type FilterByLocaleOptions,
} from './filterByLocale';
export { findPost, availableLocalesIn } from './findPost';
export {
  BLOG_INDEX,
  loadBlogBody,
  availableLocales,
  type BlogBodyModule,
} from '../../generated/blog-index';
export type {
  BlogAuthor,
  BlogIndexEntry,
  BlogLocale,
  BlogPost,
  BlogPostFrontmatter,
  BlogIndexBySlug,
} from '../../types/blog';
export { BLOG_LOCALES } from '../../types/blog';
