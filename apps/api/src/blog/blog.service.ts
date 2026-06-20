/**
 * KS-4409 / ADR-137 rev2. Публичный сервис блога. Только чтение —
 * админ-CRUD (T3) отдельный сервис, чтобы не смешивать публичную
 * и приватную поверхности.
 *
 * Источник правды — БД (`blog_posts` + `blog_authors`, T1 KS-4406).
 * Markdown→HTML рендер живёт в админе (KS-4409 п. 3); публичные
 * маршруты отдают уже готовый `body_html` из колонки `blog_posts.body_html`.
 *
 * KS-4472 / ADR-140 T6. listPosts/getPost дополнительно отдают
 * денормализованные счётчики (`viewsCount/likesCount/commentsCount`,
 * заведены в T1) и реальный `likedByMe`:
 *   - listPosts: один batched IN-query по `blog_post_likes`
 *     (postId IN (...), userId = viewer) — не N+1, не left-join'им
 *     на каждый ряд.
 *   - getPost: одиночный `findUnique` по композитному PK.
 *   - Гостям (`viewerUserId === null`) `likedByMe` всегда false без
 *     дополнительных запросов.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import {
  type BlogAuthor as SharedBlogAuthor,
  type BlogLocale,
  type BlogPostDetail,
  type BlogPostListItem,
  type BlogPostListPage,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

type BlogPost = Prisma.BlogPostModel;
type BlogAuthor = Prisma.BlogAuthorModel;

const PAGE_SIZE = 12;
const MAX_PAGE = 1000;

@Injectable()
export class BlogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /blog/posts — лента с пагинацией и опц. фильтром по тегу.
   * @param viewerUserId — id авторизованного пользователя или `null`
   *   (гость). От него зависит только `likedByMe` в выдаче; права
   *   доступа не меняются (статьи `published` публичны).
   */
  async listPosts(
    query: {
      locale: BlogLocale;
      page?: number;
      tag?: string;
    },
    viewerUserId: string | null = null,
  ): Promise<BlogPostListPage> {
    const page = Math.min(Math.max(1, query.page ?? 1), MAX_PAGE);

    const where: Prisma.BlogPostWhereInput = {
      status: 'published',
      locale: query.locale,
      publishedAt: { not: null },
      ...(query.tag ? { tags: { has: query.tag } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.blogPost.count({ where }),
      this.prisma.blogPost.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
        include: { author: true },
      }),
    ]);

    // Один batched-запрос вместо N+1: `WHERE post_id IN (...) AND user_id = $`.
    // Для гостя и для пустой страницы — Set пустой, фактического запроса нет.
    const likedSet = await this.fetchLikedSet(
      viewerUserId,
      rows.map((r) => r.id),
    );

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
      items: rows.map((r) => this.toListItem(r, likedSet.has(r.id))),
      total,
      page,
      totalPages,
    };
  }

  /**
   * GET /blog/posts/:slug — детали статьи. При отсутствии в запрошенной
   * локали — fallback на другую с `isLocaleFallback: true`. 404 если
   * статья не существует ни в одной локали (ADR-137 rev2).
   */
  async getPost(
    slug: string,
    locale: BlogLocale,
    viewerUserId: string | null = null,
  ): Promise<BlogPostDetail> {
    const inLocale = await this.prisma.blogPost.findFirst({
      where: { slug, locale, status: 'published' },
      include: { author: true },
    });
    if (inLocale) {
      const likedByMe = await this.isLikedBy(viewerUserId, inLocale.id);
      return this.toDetail(inLocale, false, likedByMe);
    }

    const otherLocale: BlogLocale = locale === 'ru' ? 'en' : 'ru';
    const fallback = await this.prisma.blogPost.findFirst({
      where: { slug, locale: otherLocale, status: 'published' },
      include: { author: true },
    });
    if (fallback) {
      const likedByMe = await this.isLikedBy(viewerUserId, fallback.id);
      return this.toDetail(fallback, true, likedByMe);
    }

    throw new NotFoundException(`Blog post slug="${slug}" not found`);
  }

  /** GET /blog/authors/:handle. */
  async getAuthor(handle: string): Promise<SharedBlogAuthor> {
    const a = await this.prisma.blogAuthor.findUnique({ where: { handle } });
    if (!a) {
      throw new NotFoundException(`Blog author "${handle}" not found`);
    }
    return this.toAuthor(a);
  }

  // ─── likedByMe helpers ────────────────────────────────────────────

  /**
   * Возвращает множество `postId`, которые лайкнул `viewerUserId`.
   * Для гостя или пустого списка — пустой Set без запросов к БД.
   */
  private async fetchLikedSet(
    viewerUserId: string | null,
    postIds: string[],
  ): Promise<Set<string>> {
    if (!viewerUserId || postIds.length === 0) {
      return new Set();
    }
    const liked = await this.prisma.blogPostLike.findMany({
      where: { userId: viewerUserId, postId: { in: postIds } },
      select: { postId: true },
    });
    return new Set(liked.map((l) => l.postId));
  }

  /**
   * Одиночная проверка лайка через композитный PK (postId, userId).
   * Возвращает false для гостя без запроса к БД.
   */
  private async isLikedBy(
    viewerUserId: string | null,
    postId: string,
  ): Promise<boolean> {
    if (!viewerUserId) return false;
    const row = await this.prisma.blogPostLike.findUnique({
      where: { postId_userId: { postId, userId: viewerUserId } },
      select: { postId: true },
    });
    return row !== null;
  }

  // ─── маппинги ──────────────────────────────────────────────────────

  private toListItem(
    post: BlogPost & { author: BlogAuthor },
    likedByMe: boolean,
  ): BlogPostListItem {
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
      // KS-4467 / KS-4472 / ADR-140. Денормализованные счётчики читаются
      // прямо из Prisma-модели (поля заведены в T1). `likedByMe`
      // приходит от вызывающего метода — для list это значение из
      // batched-Set, для detail — из одиночного PK-lookup. Для гостя
      // всегда `false`.
      viewsCount: post.viewsCount,
      likesCount: post.likesCount,
      commentsCount: post.commentsCount,
      likedByMe,
    };
  }

  private toDetail(
    post: BlogPost & { author: BlogAuthor },
    isLocaleFallback: boolean,
    likedByMe: boolean,
  ): BlogPostDetail {
    return {
      ...this.toListItem(post, likedByMe),
      bodyHtml: post.bodyHtml,
      relatedRoute: post.relatedRoute,
      updatedAt: post.updatedAt.toISOString(),
      ...(isLocaleFallback ? { isLocaleFallback: true } : {}),
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
