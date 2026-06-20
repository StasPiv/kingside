/**
 * KS-4471 / ADR-140 T5. Сервис комментариев к статьям блога.
 *
 * Эндпоинты:
 *   - `listComments(postId, cursor, limit, viewerUserId)` —
 *     GET /blog/posts/:id/comments (OptionalJwtGuard).
 *   - `createComment(postId, userId, body)` —
 *     POST /blog/posts/:id/comments (JwtAuthGuard + rate-limit).
 *   - `updateComment(commentId, userId, body)` —
 *     PATCH /blog/comments/:id (JwtAuthGuard; автор; ≤15 мин).
 *   - `deleteComment(commentId, userId)` —
 *     DELETE /blog/comments/:id (JwtAuthGuard; автор или админ).
 *
 * Бизнес-правила:
 *   - Длина 2..2000 — обеспечена class-validator'ом в DTO.
 *   - HTML вырезается до сохранения (strict-set, см. `comment-sanitize`).
 *   - В теле допустимо ≤2 URL; иначе 400.
 *   - Soft-delete: `deleted_at = now()`, `body` остаётся в БД для
 *     аудита; API при `deleted=true` отдаёт `body: null`.
 *   - Окно редактирования автором — 15 минут с `createdAt`.
 *   - Транзакционно поддерживается `blog_posts.comments_count`:
 *     +1 при insert, -1 (с защитой от минуса) при soft-delete.
 *   - Уже удалённый комментарий: повторный DELETE → 200 OK, счётчик
 *     не декрементится.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUserService } from '../auth/admin-user.guard';
import type { BlogComment, BlogCommentsPage } from '@kingside/shared';
import { countUrls, stripHtml } from './comment-sanitize';

/** Окно редактирования автором — 15 минут. */
const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Максимум URL'ов в одном комментарии. */
const MAX_URLS = 2;
/** Дефолтный размер страницы при отсутствии `limit` в query. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface DbComment {
  id: string;
  postId: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  user: { username: string | null };
}

@Injectable()
export class BlogCommentService {
  private readonly logger = new Logger(BlogCommentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminUserService,
  ) {}

  // ─── GET /blog/posts/:id/comments ────────────────────────────────

  async listComments(
    postId: string,
    rawCursor: string | undefined,
    rawLimit: number | undefined,
    viewerUserId: string | null,
  ): Promise<BlogCommentsPage> {
    await this.ensurePostExists(postId);

    const limit = this.normalizeLimit(rawLimit);
    const cursor = this.decodeCursor(rawCursor);
    const isAdmin = viewerUserId
      ? await this.adminService.isAdmin(viewerUserId)
      : false;

    // limit + 1: лишняя строка показывает, есть ли следующая страница.
    const rows = await this.prisma.blogPostComment.findMany({
      where: {
        postId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { user: { select: { username: true } } },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r) =>
      this.toBlogComment(r, viewerUserId, isAdmin),
    );
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null;

    return { items, nextCursor };
  }

  // ─── POST /blog/posts/:id/comments ───────────────────────────────

  async createComment(
    postId: string,
    userId: string,
    rawBody: string,
  ): Promise<BlogComment> {
    await this.ensurePostExists(postId);
    const body = this.sanitizeBody(rawBody);

    // Транзакция: вставка + denorm-инкремент. Если первая операция
    // прошла, а вторая упала — Prisma rollback'нет всё, никаких
    // комментариев без счётчика и наоборот.
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.blogPostComment.create({
        data: { postId, userId, body },
        include: { user: { select: { username: true } } },
      });
      await tx.blogPost.update({
        where: { id: postId },
        data: { commentsCount: { increment: 1 } },
      });
      return row;
    });

    // Автор только что создал → может редактировать (внутри окна) и удалять.
    return this.toBlogComment(created, userId, /* isAdmin */ false);
  }

  // ─── PATCH /blog/comments/:id ────────────────────────────────────

  async updateComment(
    commentId: string,
    userId: string,
    rawBody: string,
  ): Promise<BlogComment> {
    const existing = await this.prisma.blogPostComment.findUnique({
      where: { id: commentId },
      include: { user: { select: { username: true } } },
    });
    if (!existing) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException('Only the author can edit this comment');
    }
    if (existing.deletedAt) {
      throw new ForbiddenException('Cannot edit a deleted comment');
    }
    if (Date.now() - existing.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException('Edit window (15 minutes) has expired');
    }

    const body = this.sanitizeBody(rawBody);

    const updated = await this.prisma.blogPostComment.update({
      where: { id: commentId },
      data: { body },
      include: { user: { select: { username: true } } },
    });
    return this.toBlogComment(updated, userId, /* isAdmin */ false);
  }

  // ─── DELETE /blog/comments/:id ───────────────────────────────────

  async deleteComment(
    commentId: string,
    userId: string,
  ): Promise<BlogComment> {
    const existing = await this.prisma.blogPostComment.findUnique({
      where: { id: commentId },
      include: { user: { select: { username: true } } },
    });
    if (!existing) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }

    const isAdmin = await this.adminService.isAdmin(userId);
    const isAuthor = existing.userId === userId;
    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException(
        'Only the author or an admin can delete this comment',
      );
    }

    // Уже удалён — идемпотентно: 200 OK, счётчик не трогаем.
    if (existing.deletedAt) {
      return this.toBlogComment(existing, userId, isAdmin);
    }

    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.blogPostComment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
        include: { user: { select: { username: true } } },
      });
      // Защита от минуса в SQL: GREATEST(comments_count - 1, 0).
      // Prisma не поддерживает GREATEST в `update.data`, поэтому RAW.
      await tx.$queryRawUnsafe(
        `UPDATE blog_posts
         SET comments_count = GREATEST(comments_count - 1, 0)
         WHERE id = $1::uuid`,
        existing.postId,
      );
      return row;
    });

    return this.toBlogComment(deleted, userId, isAdmin);
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private async ensurePostExists(postId: string): Promise<void> {
    const post = await this.prisma.blogPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException(`Blog post ${postId} not found`);
    }
  }

  /**
   * Нормализация тела комментария: strip HTML → проверка длины
   * после strip → подсчёт URL ≤ 2. Возвращает безопасный текст для
   * сохранения в БД.
   */
  private sanitizeBody(raw: string): string {
    const stripped = stripHtml(raw);
    // После strip-тегов реальный текст может оказаться короче лимита
    // (например, входное `<p>hi</p>` → `hi` = 2). Это допустимо.
    // Но «совсем пустой» означает атакующего, который засунул только
    // теги — 400.
    if (stripped.length < 2) {
      throw new BadRequestException(
        'Comment body must contain at least 2 characters after sanitization',
      );
    }
    if (stripped.length > 2000) {
      throw new BadRequestException(
        'Comment body too long after sanitization (max 2000)',
      );
    }
    if (countUrls(stripped) > MAX_URLS) {
      throw new BadRequestException(
        `Comment body has too many URLs (max ${MAX_URLS})`,
      );
    }
    return stripped;
  }

  private normalizeLimit(raw: number | undefined): number {
    if (!raw || raw <= 0) return DEFAULT_LIMIT;
    if (raw > MAX_LIMIT) return MAX_LIMIT;
    return Math.floor(raw);
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');
  }

  private decodeCursor(
    raw: string | undefined,
  ): { createdAt: Date; id: string } | null {
    if (!raw) return null;
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const idx = decoded.lastIndexOf('|');
      if (idx < 0) return null;
      const iso = decoded.slice(0, idx);
      const id = decoded.slice(idx + 1);
      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime()) || !id) return null;
      return { createdAt, id };
    } catch (e) {
      this.logger.warn(`Bad cursor: ${(e as Error).message}`);
      return null;
    }
  }

  private toBlogComment(
    row: DbComment,
    viewerUserId: string | null,
    isAdmin: boolean,
  ): BlogComment {
    const deleted = row.deletedAt !== null;
    const isAuthor = viewerUserId !== null && row.userId === viewerUserId;
    const ageMs = Date.now() - row.createdAt.getTime();
    const inEditWindow = ageMs <= EDIT_WINDOW_MS;
    return {
      id: row.id,
      postId: row.postId,
      userId: row.userId,
      authorUsername: row.user.username ?? '',
      // Soft-delete: текст в API всегда null если запись удалена.
      body: deleted ? null : row.body,
      deleted,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: isAuthor && !deleted && inEditWindow,
      canDelete: isAuthor || isAdmin,
    };
  }
}
