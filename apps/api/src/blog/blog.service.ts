/**
 * KS-4409 / ADR-137 rev2. Публичный сервис блога. Только чтение —
 * админ-CRUD (T3) отдельный сервис, чтобы не смешивать публичную
 * и приватную поверхности.
 *
 * Источник правды — БД (`blog_posts` + `blog_authors`, T1 KS-4406).
 * Markdown→HTML рендер живёт в админе (KS-4409 п. 3); публичные
 * маршруты отдают уже готовый `body_html` из колонки `blog_posts.body_html`.
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

  /** GET /blog/posts — лента с пагинацией и опц. фильтром по тегу. */
  async listPosts(query: {
    locale: BlogLocale;
    page?: number;
    tag?: string;
  }): Promise<BlogPostListPage> {
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
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
      items: rows.map((r) => this.toListItem(r)),
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
  ): Promise<BlogPostDetail> {
    const inLocale = await this.prisma.blogPost.findFirst({
      where: { slug, locale, status: 'published' },
      include: { author: true },
    });
    if (inLocale) return this.toDetail(inLocale, false);

    const otherLocale: BlogLocale = locale === 'ru' ? 'en' : 'ru';
    const fallback = await this.prisma.blogPost.findFirst({
      where: { slug, locale: otherLocale, status: 'published' },
      include: { author: true },
    });
    if (fallback) return this.toDetail(fallback, true);

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

  // ─── маппинги ──────────────────────────────────────────────────────

  private toListItem(
    post: BlogPost & { author: BlogAuthor },
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
      // KS-4468 / ADR-140. Денормализованные счётчики читаются прямо
      // из Prisma-модели (поля заведены в T1 / KS-4467). `likedByMe`
      // здесь жёстко `false` — для гостей это корректно; для
      // авторизованных значение заполнит T6 (KS-4472) через
      // `OptionalJwtGuard` + batched IN-query по `blog_post_likes`.
      viewsCount: post.viewsCount,
      likesCount: post.likesCount,
      commentsCount: post.commentsCount,
      likedByMe: false,
    };
  }

  private toDetail(
    post: BlogPost & { author: BlogAuthor },
    isLocaleFallback: boolean,
  ): BlogPostDetail {
    return {
      ...this.toListItem(post),
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
