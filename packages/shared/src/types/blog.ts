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
