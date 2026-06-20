/**
 * KS-4413 / ADR-137 rev2. Клиент публичного API блога.
 *
 * Эндпоинты (без авторизации):
 *   GET /blog/posts?locale&page&tag → BlogPostListPage
 *   GET /blog/posts/:slug?locale     → BlogPostDetail
 *   GET /blog/authors/:handle        → BlogAuthor
 *
 * Источник истины контракта — `@kingside/shared` (KS-4408).
 * Локально ничего не дублируем.
 */
import { api } from '../api';
import type {
  BlogAuthor,
  BlogPostDetail,
  BlogPostListPage,
  BlogPostListQuery,
} from '@kingside/shared';

const BASE = '/blog';

function buildListQs(query: BlogPostListQuery): string {
  const qs = new URLSearchParams();
  qs.set('locale', query.locale);
  if (query.page !== undefined) qs.set('page', String(query.page));
  if (query.tag) qs.set('tag', query.tag);
  return qs.toString();
}

export const blogApi = {
  /** Лента опубликованных статей, 1-based пагинация (PAGE_SIZE=12). */
  listPosts(
    query: BlogPostListQuery,
    signal?: AbortSignal,
  ): Promise<BlogPostListPage> {
    return api.get<BlogPostListPage>(
      `${BASE}/posts?${buildListQs(query)}`,
      signal ? { signal } : undefined,
    );
  },

  /**
   * Одна статья по slug. Если в `locale` статьи нет — backend
   * вернёт версию на другом языке с `isLocaleFallback=true`.
   */
  getPost(
    slug: string,
    locale: BlogPostListQuery['locale'],
    signal?: AbortSignal,
  ): Promise<BlogPostDetail> {
    const qs = new URLSearchParams({ locale }).toString();
    return api.get<BlogPostDetail>(
      `${BASE}/posts/${encodeURIComponent(slug)}?${qs}`,
      signal ? { signal } : undefined,
    );
  },

  /** Полная карточка автора по handle. */
  getAuthor(handle: string, signal?: AbortSignal): Promise<BlogAuthor> {
    return api.get<BlogAuthor>(
      `${BASE}/authors/${encodeURIComponent(handle)}`,
      signal ? { signal } : undefined,
    );
  },
};
