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
  BlogLocale,
  BlogPostAdmin,
  BlogPostDetail,
  BlogPostListPage,
  BlogPostListQuery,
  BlogPostStatus,
} from '@kingside/shared';

const BASE = '/blog';
const ADMIN_BASE = '/admin/blog';

// KS-4420. Админ-CRUD контракт. Зеркалит DTO backend
// (`apps/api/src/blog/dto/blog-admin.dto.ts`). Локально, потому что
// DTO живут на api и в `@kingside/shared` не реэкспортируются.
export interface AdminBlogPostListQuery {
  status?: BlogPostStatus;
  locale?: BlogLocale;
  authorId?: string;
  page?: number;
}

export interface AdminBlogPostListPage {
  items: BlogPostAdmin[];
  total: number;
  page: number;
  totalPages: number;
}

export interface CreateBlogPostInput {
  slug: string;
  locale: BlogLocale;
  title: string;
  description: string;
  bodyMd: string;
  coverUrl?: string;
  coverAlt?: string;
  tags?: string[];
  relatedRoute?: string;
  authorId: string;
  status?: BlogPostStatus;
  publishedAt?: string;
}

/** PATCH-семантика: отсутствие поля = «не менять». */
export type UpdateBlogPostInput = Partial<CreateBlogPostInput>;

export interface CreateBlogAuthorInput {
  handle: string;
  nameRu: string;
  nameEn: string;
  avatarUrl?: string;
  bioRu?: string;
  bioEn?: string;
}

export type UpdateBlogAuthorInput = Partial<CreateBlogAuthorInput>;

export interface BlogMarkdownPreview {
  bodyHtml: string;
}

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

/**
 * KS-4420. Админ-CRUD блога. Защита — `JwtAuthGuard + AdminUserGuard`
 * (backend, KS-4410). На фронте те же маршруты обёрнуты в `<AdminRoute>`
 * — это страховка от показа экрана не-админу, проверка прав — на бэке.
 */
function buildAdminListQs(query: AdminBlogPostListQuery): string {
  const qs = new URLSearchParams();
  if (query.status) qs.set('status', query.status);
  if (query.locale) qs.set('locale', query.locale);
  if (query.authorId) qs.set('authorId', query.authorId);
  if (query.page !== undefined) qs.set('page', String(query.page));
  return qs.toString();
}

export const blogAdminApi = {
  // ─── posts ────────────────────────────────────────────────────────
  listPosts(
    query: AdminBlogPostListQuery = {},
    signal?: AbortSignal,
  ): Promise<AdminBlogPostListPage> {
    const qs = buildAdminListQs(query);
    const url = qs ? `${ADMIN_BASE}/posts?${qs}` : `${ADMIN_BASE}/posts`;
    return api.get<AdminBlogPostListPage>(url, signal ? { signal } : undefined);
  },

  getPost(id: string, signal?: AbortSignal): Promise<BlogPostAdmin> {
    return api.get<BlogPostAdmin>(
      `${ADMIN_BASE}/posts/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
  },

  createPost(body: CreateBlogPostInput): Promise<BlogPostAdmin> {
    return api.post<BlogPostAdmin>(`${ADMIN_BASE}/posts`, body);
  },

  /**
   * Backend ожидает PUT с PATCH-семантикой (см. UpdateBlogPostDto:
   * все поля опц.). Если у нашего api-клиента есть метод `put` —
   * используем его, иначе fallback на универсальный `request`.
   */
  updatePost(id: string, body: UpdateBlogPostInput): Promise<BlogPostAdmin> {
    return api.put<BlogPostAdmin>(
      `${ADMIN_BASE}/posts/${encodeURIComponent(id)}`,
      body,
    );
  },

  deletePost(id: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(
      `${ADMIN_BASE}/posts/${encodeURIComponent(id)}`,
    );
  },

  /**
   * Превью Markdown через backend — гарантирует совпадение с тем,
   * как тело отрендерится на публичной странице (та же
   * `unified + remark + rehype-sanitize`-цепочка, ADR-137 rev2 §1).
   */
  previewMarkdown(bodyMd: string): Promise<BlogMarkdownPreview> {
    return api.post<BlogMarkdownPreview>(
      `${ADMIN_BASE}/posts/preview`,
      { bodyMd },
    );
  },

  // ─── authors ──────────────────────────────────────────────────────
  listAuthors(signal?: AbortSignal): Promise<BlogAuthor[]> {
    return api.get<BlogAuthor[]>(
      `${ADMIN_BASE}/authors`,
      signal ? { signal } : undefined,
    );
  },

  getAuthor(id: string, signal?: AbortSignal): Promise<BlogAuthor> {
    return api.get<BlogAuthor>(
      `${ADMIN_BASE}/authors/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
  },

  createAuthor(body: CreateBlogAuthorInput): Promise<BlogAuthor> {
    return api.post<BlogAuthor>(`${ADMIN_BASE}/authors`, body);
  },

  updateAuthor(id: string, body: UpdateBlogAuthorInput): Promise<BlogAuthor> {
    return api.put<BlogAuthor>(
      `${ADMIN_BASE}/authors/${encodeURIComponent(id)}`,
      body,
    );
  },

  deleteAuthor(id: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(
      `${ADMIN_BASE}/authors/${encodeURIComponent(id)}`,
    );
  },
};
