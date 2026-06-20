/**
 * KS-4394 / ADR-137 T2. Поиск записи статьи в индексе по slug + locale.
 *
 * Тонкий помощник вокруг `BLOG_INDEX`: страница `/blog/:slug` зовёт
 * `findPost(slug, locale)` чтобы получить фронтматтер. Если в нужной
 * локали записи нет, но статья существует в другой — возвращаем
 * доступную с флагом `isLocaleFallback: true` (опционально через
 * `allowFallback`). Так UI понимает, что нужно показать плашку «не
 * переведено».
 */
import type { BlogIndexEntry, BlogLocale } from '../../types/blog';
import {
  filterByLocale,
  type BlogListEntry,
} from './filterByLocale';

export function findPost(
  entries: readonly BlogIndexEntry[],
  slug: string,
  locale: BlogLocale,
  opts: { allowFallback?: boolean } = {},
): BlogListEntry | null {
  const allowFallback = opts.allowFallback ?? true;
  // Точное попадание — приоритет, без затрат на `filterByLocale`.
  for (const e of entries) {
    if (e.slug === slug && e.locale === locale) {
      return { ...e, isLocaleFallback: false };
    }
  }
  if (!allowFallback) return null;
  const list = filterByLocale(entries, locale, { allowFallback: true });
  const fallback = list.find((e) => e.slug === slug);
  return fallback ?? null;
}

/**
 * Перечень локалей, в которых статья реально существует. Для UI-фильтра
 * «эта статья переведена на EN — переключи язык» и аналитики.
 */
export function availableLocalesIn(
  entries: readonly BlogIndexEntry[],
  slug: string,
): readonly BlogLocale[] {
  const out: BlogLocale[] = [];
  for (const e of entries) {
    if (e.slug === slug && !out.includes(e.locale)) out.push(e.locale);
  }
  return out;
}
