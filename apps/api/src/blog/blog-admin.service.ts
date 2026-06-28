/**
 * KS-4410 / ADR-137 rev2. Админ-сервис блога. CRUD статей и авторов,
 * preview Markdown, смена статуса. На save (create/update) рендерит
 * `bodyMd → bodyHtml` через `renderMarkdownToHtml` и пересчитывает
 * `readingTimeMin` через `estimateReadingTimeMin`.
 *
 * Изолирован от публичного `BlogService` — чтобы случайная утечка
 * админ-метода на публичный controller не отдала черновики.
 */
import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import {
  type BlogAuthor as SharedBlogAuthor,
  type BlogLocale,
  type BlogPostAdmin,
  type BlogPostStatus,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
// KS-4616. Prerender-хуки на mutation посторядка `(create/update/delete/
// setStatus)` — кладут в SQS задачу типа `blog-post`, воркер сохраняет
// HTML в `s3://kingside-prerender-store/{locale}/blog/<slug>.html`.
// Best-effort: ошибки SQS не валят основную операцию.
import { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';
// KS-4740: broadcast Notification на publish — для колокольчика.
import { NotificationService } from '../notification/notification.service';
import { estimateReadingTimeMin, renderMarkdownToHtml } from './markdown';

type BlogPost = Prisma.BlogPostModel;
type BlogAuthor = Prisma.BlogAuthorModel;

const PAGE_SIZE = 24;

@Injectable()
export class BlogAdminService {
  private readonly logger = new Logger(BlogAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prerender: PrerenderEnqueueService,
    // KS-4740: broadcast Notification «новый пост блога». `@Optional`
    // — для unit-spec'ов, конструирующих сервис без полного DI.
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  /**
   * KS-4740. Идемпотентный hook на публикацию: один раз на пост
   * рассылает Notification всем активным пользователям + WS-emit.
   * Дедуп через `BlogPost.publishedNotificationSentAt` — UPDATE
   * с `WHERE publishedNotificationSentAt IS NULL` гарантирует, что
   * два параллельных publish'а не уйдут в две рассылки.
   *
   * Best-effort: ошибка broadcast не валит publish.
   */
  private async notifyBlogPublished(post: BlogPost): Promise<void> {
    if (post.status !== 'published' || post.publishedAt === null) return;
    try {
      // CAS-update: возвращает count=1 только если до этого
      // publishedNotificationSentAt был NULL. На повторный вызов с
      // тем же id вернёт 0 → пропускаем broadcast.
      const claim = await this.prisma.blogPost.updateMany({
        where: { id: post.id, publishedNotificationSentAt: null },
        data: { publishedNotificationSentAt: new Date() },
      });
      if (claim.count === 0) {
        return; // уже отправляли ранее
      }
      if (!this.notifications) return;
      await this.notifications.createBroadcast('blog_post_published', {
        post_id: post.id,
        slug: post.slug,
        locale: post.locale,
        title: post.title,
        description: post.description,
        cover_url: post.coverUrl,
        published_at: post.publishedAt.toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `notifyBlogPublished post=${post.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * KS-4616. Поставить prerender-задачу на пост блога. Тонкий хелпер,
   * чтобы place-of-call'ы остались однострочными. `locale` приходит
   * из БД (`BlogLocale` = 'ru' | 'en') — расширение списка локалей
   * потребует синхронной правки `PrerenderTask` в shared.
   */
  private enqueueBlogPostPrerender(post: {
    locale: string;
    slug: string;
  }): void {
    // BlogPost.locale в Prisma-модели — `String`, не enum; в shared
    // `BlogLocale = 'ru' | 'en'`. Защита от рассогласования: если в
    // БД появится новая локаль раньше, чем расширим shared, лучше
    // пропустить enqueue, чем кидать ошибку из mutation-хука.
    if (post.locale !== 'ru' && post.locale !== 'en') return;
    this.prerender.enqueueFireAndForget({
      kind: 'blog-post',
      locale: post.locale,
      slug: post.slug,
    });
  }

  // ─── posts ─────────────────────────────────────────────────────────

  async listPosts(query: {
    status?: BlogPostStatus;
    locale?: BlogLocale;
    authorId?: string;
    page?: number;
  }): Promise<{
    items: BlogPostAdmin[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const where: Prisma.BlogPostWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.locale) where.locale = query.locale;
    if (query.authorId) where.authorId = query.authorId;

    const [total, rows] = await Promise.all([
      this.prisma.blogPost.count({ where }),
      this.prisma.blogPost.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
        include: { author: true },
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
      items: rows.map((r) => this.toAdminPost(r)),
      total,
      page,
      totalPages,
    };
  }

  async getPost(id: string): Promise<BlogPostAdmin> {
    const row = await this.prisma.blogPost.findUnique({
      where: { id },
      include: { author: true },
    });
    if (!row) {
      throw new NotFoundException(`Blog post ${id} not found`);
    }
    return this.toAdminPost(row);
  }

  async createPost(input: {
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
  }): Promise<BlogPostAdmin> {
    await this.ensureAuthorExists(input.authorId);
    const bodyHtml = await renderMarkdownToHtml(input.bodyMd);
    const readingTimeMin = estimateReadingTimeMin(input.bodyMd);
    const status = input.status ?? 'draft';
    const publishedAt =
      input.publishedAt != null
        ? new Date(input.publishedAt)
        : status === 'published'
          ? new Date()
          : null;

    const row = await this.prisma.blogPost.create({
      data: {
        slug: input.slug,
        locale: input.locale,
        title: input.title,
        description: input.description,
        bodyMd: input.bodyMd,
        bodyHtml,
        coverUrl: input.coverUrl ?? null,
        coverAlt: input.coverAlt ?? null,
        tags: input.tags ?? [],
        relatedRoute: input.relatedRoute ?? null,
        readingTimeMin,
        status,
        publishedAt,
        authorId: input.authorId,
      },
      include: { author: true },
    });
    // KS-4616. Сразу при создании заводим snapshot в S3 — статья
    // может появиться в публике до первого update (например, через
    // service-account script). Для draft-постов snapshot тоже есть
    // смысл (preview-окружение), а лишние SQS-сообщения дёшевы.
    this.enqueueBlogPostPrerender({ locale: row.locale, slug: row.slug });
    // KS-4740: если пост создан сразу как `published` — broadcast.
    await this.notifyBlogPublished(row);
    return this.toAdminPost(row);
  }

  async updatePost(
    id: string,
    input: {
      slug?: string;
      locale?: BlogLocale;
      title?: string;
      description?: string;
      bodyMd?: string;
      coverUrl?: string | null;
      coverAlt?: string | null;
      tags?: string[];
      relatedRoute?: string | null;
      authorId?: string;
      status?: BlogPostStatus;
      publishedAt?: string | null;
    },
  ): Promise<BlogPostAdmin> {
    const current = await this.prisma.blogPost.findUnique({
      where: { id },
      select: {
        status: true,
        publishedAt: true,
        authorId: true,
        bodyMd: true,
        // KS-4616. `slug` и `locale` нужны для prerender-хука: если slug
        // меняется в этом же запросе, нужно дополнительно дёрнуть
        // snapshot по старому пути (он перепишется новым HTML, что
        // лучше чем устаревший вариант в S3 до следующего sitemap-цикла).
        slug: true,
        locale: true,
      },
    });
    if (!current) {
      throw new NotFoundException(`Blog post ${id} not found`);
    }
    if (input.authorId && input.authorId !== current.authorId) {
      await this.ensureAuthorExists(input.authorId);
    }

    const data: Prisma.BlogPostUpdateInput = {};
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.locale !== undefined) data.locale = input.locale;
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.bodyMd !== undefined) {
      data.bodyMd = input.bodyMd;
      data.bodyHtml = await renderMarkdownToHtml(input.bodyMd);
      data.readingTimeMin = estimateReadingTimeMin(input.bodyMd);
    }
    if (input.coverUrl !== undefined) data.coverUrl = input.coverUrl;
    if (input.coverAlt !== undefined) data.coverAlt = input.coverAlt;
    if (input.tags !== undefined) data.tags = input.tags;
    if (input.relatedRoute !== undefined) data.relatedRoute = input.relatedRoute;
    if (input.authorId !== undefined) {
      data.author = { connect: { id: input.authorId } };
    }
    if (input.status !== undefined) {
      data.status = input.status;
      // Переход draft → published: если publishedAt не задан явно
      // в этом же запросе и в БД ещё null — выставить сейчас.
      if (
        input.status === 'published' &&
        input.publishedAt === undefined &&
        current.publishedAt === null
      ) {
        data.publishedAt = new Date();
      }
    }
    if (input.publishedAt !== undefined) {
      data.publishedAt =
        input.publishedAt === null ? null : new Date(input.publishedAt);
    }

    const row = await this.prisma.blogPost.update({
      where: { id },
      data,
      include: { author: true },
    });
    // KS-4616. Snapshot для новой (current) пары locale+slug.
    this.enqueueBlogPostPrerender({ locale: row.locale, slug: row.slug });
    // Если slug или locale изменились — обновим и старый путь, чтобы
    // в S3 не остался устаревший HTML под прежним ключом.
    if (
      (input.slug !== undefined && input.slug !== current.slug) ||
      (input.locale !== undefined && input.locale !== current.locale)
    ) {
      this.enqueueBlogPostPrerender({
        locale: current.locale,
        slug: current.slug,
      });
    }
    // KS-4740: переход draft → published (или create-as-published мы
    // ловим в createPost). Дедуп через `publishedNotificationSentAt` —
    // повторный publish после edit'a не плодит вторую рассылку.
    await this.notifyBlogPublished(row);
    return this.toAdminPost(row);
  }

  async deletePost(id: string): Promise<void> {
    // KS-4616. До delete достаём locale+slug — нужно обновить snapshot
    // после удаления (страница начнёт отдавать «не найдено», prerender
    // воркер увидит 404 и сохранит «not-found»-HTML; если просто не
    // делать ничего, в S3 останется устаревший snapshot со старым
    // содержимым до конца жизни ключа).
    const before = await this.prisma.blogPost.findUnique({
      where: { id },
      select: { slug: true, locale: true },
    });
    try {
      await this.prisma.blogPost.delete({ where: { id } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') {
        throw new NotFoundException(`Blog post ${id} not found`);
      }
      throw err;
    }
    if (before) {
      this.enqueueBlogPostPrerender({
        locale: before.locale,
        slug: before.slug,
      });
    }
  }

  async setStatus(id: string, status: BlogPostStatus): Promise<BlogPostAdmin> {
    return this.updatePost(id, { status });
  }

  async previewMarkdown(bodyMd: string): Promise<{
    bodyHtml: string;
    readingTimeMin: number;
  }> {
    const bodyHtml = await renderMarkdownToHtml(bodyMd);
    const readingTimeMin = estimateReadingTimeMin(bodyMd);
    return { bodyHtml, readingTimeMin };
  }

  // ─── authors ───────────────────────────────────────────────────────

  async listAuthors(): Promise<SharedBlogAuthor[]> {
    const rows = await this.prisma.blogAuthor.findMany({
      orderBy: { handle: 'asc' },
    });
    return rows.map((a) => this.toAuthor(a));
  }

  async getAuthor(id: string): Promise<SharedBlogAuthor> {
    const a = await this.prisma.blogAuthor.findUnique({ where: { id } });
    if (!a) throw new NotFoundException(`Blog author ${id} not found`);
    return this.toAuthor(a);
  }

  async createAuthor(input: {
    handle: string;
    nameRu: string;
    nameEn: string;
    avatarUrl?: string;
    bioRu?: string;
    bioEn?: string;
  }): Promise<SharedBlogAuthor> {
    const row = await this.prisma.blogAuthor.create({
      data: {
        handle: input.handle,
        nameRu: input.nameRu,
        nameEn: input.nameEn,
        avatarUrl: input.avatarUrl ?? null,
        bioRu: input.bioRu ?? null,
        bioEn: input.bioEn ?? null,
      },
    });
    return this.toAuthor(row);
  }

  async updateAuthor(
    id: string,
    input: {
      handle?: string;
      nameRu?: string;
      nameEn?: string;
      avatarUrl?: string | null;
      bioRu?: string | null;
      bioEn?: string | null;
    },
  ): Promise<SharedBlogAuthor> {
    const data: Prisma.BlogAuthorUpdateInput = {};
    if (input.handle !== undefined) data.handle = input.handle;
    if (input.nameRu !== undefined) data.nameRu = input.nameRu;
    if (input.nameEn !== undefined) data.nameEn = input.nameEn;
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;
    if (input.bioRu !== undefined) data.bioRu = input.bioRu;
    if (input.bioEn !== undefined) data.bioEn = input.bioEn;
    try {
      const row = await this.prisma.blogAuthor.update({
        where: { id },
        data,
      });
      return this.toAuthor(row);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') {
        throw new NotFoundException(`Blog author ${id} not found`);
      }
      throw err;
    }
  }

  async deleteAuthor(id: string): Promise<void> {
    try {
      await this.prisma.blogAuthor.delete({ where: { id } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') {
        throw new NotFoundException(`Blog author ${id} not found`);
      }
      // P2003 — нарушение FK (BlogPost.authorId → BlogAuthor). У нас
      // ON DELETE RESTRICT, удаление невозможно пока есть посты.
      if (code === 'P2003') {
        throw new NotFoundException(
          `Blog author ${id} has posts and cannot be deleted`,
        );
      }
      throw err;
    }
  }

  /**
   * KS-4616. Разовая перепостановка prerender-задач для всех уже
   * опубликованных постов — нужно после первой выкатки KS-4616,
   * чтобы наполнить `s3://kingside-prerender-store/{locale}/blog/`
   * без ожидания следующей правки каждой статьи. После того как S3
   * наполнится один раз, mutation-хуки в `createPost/updatePost/
   * deletePost` поддерживают snapshot'ы актуальными.
   *
   * Возвращает количество поставленных задач. Безопасно вызывать
   * многократно: воркер идемпотентен по ключу `{locale}/blog/<slug>.html`,
   * повторное сохранение перезапишет существующий HTML.
   */
  async reindexPrerenderForPublished(): Promise<{
    enqueued: number;
    posts: Array<{ slug: string; locale: BlogLocale }>;
  }> {
    const rows = await this.prisma.blogPost.findMany({
      where: { status: 'published' },
      select: { slug: true, locale: true },
    });
    let enqueued = 0;
    for (const row of rows) {
      if (row.locale !== 'ru' && row.locale !== 'en') continue;
      this.prerender.enqueueFireAndForget({
        kind: 'blog-post',
        locale: row.locale,
        slug: row.slug,
      });
      enqueued += 1;
    }
    return {
      enqueued,
      posts: rows
        .filter((r) => r.locale === 'ru' || r.locale === 'en')
        .map((r) => ({ slug: r.slug, locale: r.locale as BlogLocale })),
    };
  }

  /**
   * KS-4672. Разовая операция: пересобрать `bodyHtml` и
   * `readingTimeMin` всех постов из их актуального `bodyMd`. Нужна
   * после правок `markdown.ts` (новые HAST-свойства / sanitize-схема)
   * — кэшированный HTML в БД иначе не получит изменений до следующего
   * `PATCH` на пост.
   *
   * Идемпотентна: если HTML не изменился — UPDATE пропускается
   * (Prisma даже без сравнения сделает UPDATE, поэтому сравниваем
   * сами; это режет лишние invalidation'ы и audit-логи).
   *
   * Защищена `blog:write` scope на контроллере. Mutation-хуки
   * (prerender-reindex) триггерим только для опубликованных постов,
   * у которых HTML действительно изменился — иначе SQS-spam.
   */
  async recomputeHtmlForAllPosts(): Promise<{
    total: number;
    updated: number;
    unchanged: number;
  }> {
    const rows = await this.prisma.blogPost.findMany({
      select: {
        id: true,
        slug: true,
        locale: true,
        status: true,
        bodyMd: true,
        bodyHtml: true,
        readingTimeMin: true,
      },
    });
    let updated = 0;
    let unchanged = 0;
    for (const row of rows) {
      const nextHtml = await renderMarkdownToHtml(row.bodyMd);
      const nextReading = estimateReadingTimeMin(row.bodyMd);
      if (
        nextHtml === row.bodyHtml &&
        nextReading === row.readingTimeMin
      ) {
        unchanged += 1;
        continue;
      }
      await this.prisma.blogPost.update({
        where: { id: row.id },
        data: {
          bodyHtml: nextHtml,
          readingTimeMin: nextReading,
        },
      });
      updated += 1;
      // KS-4616. Для опубликованных постов поставим prerender-задачу —
      // иначе snapshot в S3 останется со старым HTML до следующего
      // `PATCH` или sitemap-цикла.
      if (
        row.status === 'published' &&
        (row.locale === 'ru' || row.locale === 'en')
      ) {
        this.prerender.enqueueFireAndForget({
          kind: 'blog-post',
          locale: row.locale,
          slug: row.slug,
        });
      }
    }
    return { total: rows.length, updated, unchanged };
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async ensureAuthorExists(id: string): Promise<void> {
    const a = await this.prisma.blogAuthor.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!a) throw new NotFoundException(`Blog author ${id} not found`);
  }

  private toAdminPost(
    post: BlogPost & { author: BlogAuthor },
  ): BlogPostAdmin {
    return {
      id: post.id,
      slug: post.slug,
      locale: post.locale === 'en' ? 'en' : 'ru',
      title: post.title,
      description: post.description,
      coverUrl: post.coverUrl,
      coverAlt: post.coverAlt,
      tags: post.tags,
      readingTimeMin: post.readingTimeMin,
      publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
      author: {
        id: post.author.id,
        handle: post.author.handle,
        nameRu: post.author.nameRu,
        nameEn: post.author.nameEn,
      },
      bodyHtml: post.bodyHtml,
      relatedRoute: post.relatedRoute,
      updatedAt: post.updatedAt.toISOString(),
      bodyMd: post.bodyMd,
      status: post.status === 'published' ? 'published' : 'draft',
      createdAt: post.createdAt.toISOString(),
      authorId: post.authorId,
      // KS-4468 / ADR-140. Денормализованные счётчики из Prisma-модели
      // (поля заведены в T1 / KS-4467). `likedByMe` для админ-DTO
      // содержательной нагрузки не несёт — админ читает черновики
      // без сессии-пользователя; по форме типа возвращаем `false`.
      viewsCount: post.viewsCount,
      likesCount: post.likesCount,
      commentsCount: post.commentsCount,
      likedByMe: false,
    };
  }

  private toAuthor(a: BlogAuthor): SharedBlogAuthor {
    return {
      id: a.id,
      handle: a.handle,
      nameRu: a.nameRu,
      nameEn: a.nameEn,
      avatarUrl: a.avatarUrl,
      bioRu: a.bioRu,
      bioEn: a.bioEn,
    };
  }
}
