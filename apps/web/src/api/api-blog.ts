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
  BlogViewResponse,
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

/**
 * KS-4449 / ADR-138 T10. Расширения для multipart-запросов: загрузка
 * обложки (`coverFile`) и/или сброс уже привязанной (`coverReset`).
 * Если ничего из них не задано — методы шлют обычный JSON, как раньше.
 */
export interface BlogPostCoverOptions {
  coverFile?: File | null;
  coverReset?: boolean;
}

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

  /**
   * KS-4474 / ADR-140 §2.2 T8. Регистрация просмотра статьи.
   *
   * Backend (`POST /blog/posts/:id/view`) — идемпотентен в окне 24ч:
   * повторный вызов в пределах суток вернёт `counted=false` с тем же
   * `viewsCount` (Redis-дедуп по `userId | sha1(ip+UA)`). Бот-UA и
   * чужой Origin/Referer тоже отдают `counted=false`, инкремента нет.
   *
   * Клиенту это позволяет всегда писать `viewsCount` из ответа в
   * локальный state как новый источник правды — без отдельного GET.
   * Фронт-дедуп через `sessionStorage` (см. BlogPostPage) — лишь
   * экономия сетевого вызова: на back/forward в той же вкладке мы и
   * так знаем, что в сутки уже было.
   *
   * Без `AbortSignal`: вызов fire-and-forget из таймера 5с, отмена
   * не нужна — если пользователь ушёл со страницы до ответа, лишний
   * `setState` отсечёт guard на стороне BlogPostPage.
   */
  recordView(postId: string): Promise<BlogViewResponse> {
    return api.post<BlogViewResponse>(
      `${BASE}/posts/${encodeURIComponent(postId)}/view`,
      {},
    );
  },
};

/**
 * KS-4449 / ADR-138 T10. Условие включения multipart-варианта для
 * `POST/PUT /admin/blog/posts*`: либо приходит файл, либо явный
 * сброс уже привязанной обложки. Без обоих — обычный JSON.
 */
function needsMultipart(cover?: BlogPostCoverOptions): boolean {
  if (!cover) return false;
  return Boolean(cover.coverFile) || cover.coverReset === true;
}

/**
 * Собирает `FormData` для `POST/PUT /admin/blog/posts*`:
 *   - примитивы (string/number/boolean) — как поля формы;
 *   - `tags` — JSON-строкой (DTO принимает либо JSON, либо
 *     полевые повторы; JSON безопаснее для пустого массива и
 *     отсутствия экранирования);
 *   - `coverFile` — отдельным полем `cover` (имя поля совпадает с
 *     `@UploadedFile()` на бэкенде);
 *   - `coverReset=true` — поле `coverReset='true'` (PATCH-сигнал «убрать»).
 *
 * Пустые/`undefined` значения не отправляем — это PATCH-семантика для
 * update (бэкенд не меняет поля, которые не пришли). Для create
 * обязательные поля у нас всегда заполнены; если их нет — это будет
 * ошибка валидации DTO, не наша забота.
 */
function buildBlogPostFormData(
  body: CreateBlogPostInput | UpdateBlogPostInput,
  cover: BlogPostCoverOptions | undefined,
): FormData {
  const fd = new FormData();
  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'boolean') {
      fd.append(key, value ? 'true' : 'false');
    } else if (Array.isArray(value)) {
      fd.append(key, JSON.stringify(value));
    } else {
      fd.append(key, String(value));
    }
  };

  // Порядок здесь не важен — backend читает по имени. Перечисляем
  // все возможные поля; те, что не заданы, append-функция пропустит.
  const fields: ReadonlyArray<keyof CreateBlogPostInput> = [
    'slug',
    'locale',
    'title',
    'description',
    'bodyMd',
    'coverUrl',
    'coverAlt',
    'tags',
    'relatedRoute',
    'authorId',
    'status',
    'publishedAt',
  ];
  for (const key of fields) {
    append(key, (body as Record<string, unknown>)[key]);
  }

  if (cover?.coverFile) {
    fd.append('cover', cover.coverFile, cover.coverFile.name);
  }
  if (cover?.coverReset) {
    append('coverReset', true);
  }

  return fd;
}

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

  createPost(
    body: CreateBlogPostInput,
    cover?: BlogPostCoverOptions,
  ): Promise<BlogPostAdmin> {
    if (needsMultipart(cover)) {
      return api.postForm<BlogPostAdmin>(
        `${ADMIN_BASE}/posts`,
        buildBlogPostFormData(body, cover),
      );
    }
    return api.post<BlogPostAdmin>(`${ADMIN_BASE}/posts`, body);
  },

  /**
   * Backend ожидает PUT с PATCH-семантикой (см. UpdateBlogPostDto:
   * все поля опц.). При наличии файла/сброса обложки — multipart.
   */
  updatePost(
    id: string,
    body: UpdateBlogPostInput,
    cover?: BlogPostCoverOptions,
  ): Promise<BlogPostAdmin> {
    if (needsMultipart(cover)) {
      return api.putForm<BlogPostAdmin>(
        `${ADMIN_BASE}/posts/${encodeURIComponent(id)}`,
        buildBlogPostFormData(body, cover),
      );
    }
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
