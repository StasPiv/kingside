/**
 * KS-4410 / ADR-137 rev2. Админ-сервис блога. CRUD статей и авторов,
 * preview Markdown, смена статуса. На save (create/update) рендерит
 * `bodyMd → bodyHtml` через `renderMarkdownToHtml` и пересчитывает
 * `readingTimeMin` через `estimateReadingTimeMin`.
 *
 * Изолирован от публичного `BlogService` — чтобы случайная утечка
 * админ-метода на публичный controller не отдала черновики.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import {
  type BlogAuthor as SharedBlogAuthor,
  type BlogLocale,
  type BlogPostAdmin,
  type BlogPostStatus,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { estimateReadingTimeMin, renderMarkdownToHtml } from './markdown';

type BlogPost = Prisma.BlogPostModel;
type BlogAuthor = Prisma.BlogAuthorModel;

const PAGE_SIZE = 24;

@Injectable()
export class BlogAdminService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.toAdminPost(row);
  }

  async deletePost(id: string): Promise<void> {
    try {
      await this.prisma.blogPost.delete({ where: { id } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2025') {
        throw new NotFoundException(`Blog post ${id} not found`);
      }
      throw err;
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
