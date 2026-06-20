/**
 * KS-4408 / ADR-137 rev2. API-контракты раздела `/blog`. Единый источник
 * истины для backend (`apps/api/src/blog`) и frontend (страницы блога,
 * админ-CRUD). Источник правды по контенту — БД (см. T1 KS-4406);
 * markdown-файлы во фронте перестали быть авторитетом.
 */

/** Поддерживаемые локали блога. */
export type BlogLocale = 'ru' | 'en';

/**
 * Статус публикации. `'published'` — попадает на публичные эндпоинты;
 * `'draft'` доступен только админ-API.
 */
export type BlogPostStatus = 'draft' | 'published';

/**
 * Автор статьи. MVP — один сидовый автор `handle='kingside'`,
 * структура поддерживает расширение.
 */
export interface BlogAuthor {
  id: string;
  /** Стабильный slug-style идентификатор автора (UNIQUE). */
  handle: string;
  nameRu: string;
  nameEn: string;
  avatarUrl: string | null;
  bioRu: string | null;
  bioEn: string | null;
}

/**
 * Элемент ленты `/blog/posts`. Сжато для карточки списка — без
 * полного `bodyHtml`, который тяжёлый.
 */
export interface BlogPostListItem {
  id: string;
  slug: string;
  locale: BlogLocale;
  title: string;
  description: string;
  coverUrl: string | null;
  coverAlt: string | null;
  tags: string[];
  readingTimeMin: number;
  /** ISO-8601. `null` для черновиков (на публичные эндпоинты не попадают). */
  publishedAt: string | null;
  /**
   * Автор в компактном виде — `id`, `handle` и пара локалевых имён.
   * Полные поля автора достаются через `GET /blog/authors/:handle`.
   */
  author: Pick<BlogAuthor, 'id' | 'handle' | 'nameRu' | 'nameEn'>;
  /**
   * `true`, если по запрошенной локали статья отсутствует и сервер
   * вернул другую (`/blog/posts/:slug?locale=ru` → найдено en).
   * В ленте `/blog/posts` всегда `false` или отсутствует — там фильтр
   * по локали жёсткий.
   */
  isLocaleFallback?: boolean;
  /**
   * KS-4467/KS-4468 / ADR-140 §2.1. Денормализованные счётчики
   * вовлечённости — берутся из колонок `blog_posts.*_count` без
   * агрегатов, чтобы лента и карточка статьи отдавались одним
   * запросом. Источник правды для лайков/комментариев — детальные
   * таблицы; суточный cron (T7) выправляет дрейф.
   */
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  /**
   * KS-4468 / ADR-140. `true`, если запрос идёт от авторизованного
   * пользователя и его лайк по этой статье есть. Для гостей всегда
   * `false`. Сервер заполняет либо batched IN-query (для ленты), либо
   * left-join (для одиночной статьи).
   */
  likedByMe: boolean;
}

/**
 * Страница статьи `/blog/posts/:slug`. Расширяет ListItem полным
 * `bodyHtml` + связанным маршрутом и `updatedAt`.
 */
export interface BlogPostDetail extends BlogPostListItem {
  /** Готовый HTML после `unified + remark + rehype-sanitize`. */
  bodyHtml: string;
  /** Опц. ссылка на связанный раздел (`/lectures/<id>` и т. п.) для
   *  блока «По теме». */
  relatedRoute: string | null;
  updatedAt: string;
}

/**
 * Полная форма для админ-CRUD `/admin/blog/posts/:id`. Содержит
 * черновик и исходный `bodyMd` — публичные эндпоинты их не отдают.
 */
export interface BlogPostAdmin extends BlogPostDetail {
  /** Исходный Markdown — редактируется через админ. */
  bodyMd: string;
  status: BlogPostStatus;
  createdAt: string;
  authorId: string;
}

// ─── Списки / ответы публичных эндпоинтов ───────────────────────────

export interface BlogPostListPage {
  items: BlogPostListItem[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * Query-параметры `GET /blog/posts`. `page` — 1-based.
 */
export interface BlogPostListQuery {
  locale: BlogLocale;
  page?: number;
  tag?: string;
}

// ─── ADR-140: вовлечённость — лайки, просмотры, комментарии ─────────

/**
 * KS-4468 / ADR-140 §3. Комментарий к статье блога. Плоская лента,
 * без вложенных ответов (MVP). Soft-delete: при `deleted: true`
 * сервер возвращает `body: null`, но запись остаётся в ленте, чтобы
 * не сбивать порядок и курсорную пагинацию.
 *
 * `canEdit` — true только для автора, не-удалённого комментария и в
 * пределах 15-минутного окна с момента `createdAt`.
 * `canDelete` — true для автора или администратора. Удаление —
 * soft (см. T5).
 */
export interface BlogComment {
  id: string;
  postId: string;
  userId: string;
  /** Username автора (на момент рендера; не FK-источник). */
  authorUsername: string;
  /** `null` если комментарий удалён (soft-delete). */
  body: string | null;
  deleted: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * KS-4468 / ADR-140 §3. Страница комментариев `GET /blog/posts/:id/comments`.
 * Cursor-пагинация по `(createdAt DESC, id DESC)` — стабильная при
 * совпадении `createdAt`. `nextCursor === null` — больше нет.
 */
export interface BlogCommentsPage {
  items: BlogComment[];
  nextCursor: string | null;
}

/**
 * KS-4468 / ADR-140 §2.2. Ответ `POST /blog/posts/:id/view`.
 * `counted=false` — повтор в окне 24ч (Redis-дедуп) либо отсев бота /
 * чужой Origin. В обоих случаях клиент получает актуальный `viewsCount`
 * без отдельного `GET`.
 */
export interface BlogViewResponse {
  viewsCount: number;
  counted: boolean;
}

/**
 * KS-4468 / ADR-140 §2.1. Ответ `POST` и `DELETE` `/blog/posts/:id/like`.
 * Оба эндпоинта идемпотентны: повторный POST не инкрементит, повторный
 * DELETE не декрементит. Клиент использует `likesCount`/`likedByMe`
 * как новый источник правды для UI без отдельного GET.
 */
export interface BlogLikeResponse {
  likesCount: number;
  likedByMe: boolean;
}
