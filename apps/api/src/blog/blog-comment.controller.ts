/**
 * KS-4471 / ADR-140 T5. Маршруты комментариев к статьям блога.
 *
 *   GET    /blog/posts/:id/comments   — OptionalJwtGuard, cursor-page.
 *   POST   /blog/posts/:id/comments   — JwtAuthGuard + per-user 1/30s + 30/час.
 *   PATCH  /blog/comments/:id         — JwtAuthGuard (автор, 15-мин окно).
 *   DELETE /blog/comments/:id         — JwtAuthGuard (автор или админ; soft).
 *
 * Лежит отдельным контроллером от `BlogController`: смешанные пути
 * `posts/:id/comments` и `comments/:id` логически принадлежат одному
 * домену (комментарии), и держать их вместе компактнее, чем пихать в
 * публичный `BlogController`.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { BlogCommentService } from './blog-comment.service';
import { BlogCommentCreateRateLimitGuard } from './blog-comment-rate-limit.guard';
import { CreateBlogCommentDto } from './dto/create-blog-comment.dto';
import { UpdateBlogCommentDto } from './dto/update-blog-comment.dto';
import { ListBlogCommentsDto } from './dto/list-blog-comments.dto';
import type { BlogComment, BlogCommentsPage } from '@kingside/shared';

@Controller('blog')
export class BlogCommentController {
  constructor(private readonly service: BlogCommentService) {}

  /**
   * GET /blog/posts/:id/comments?cursor=&limit=20.
   * OptionalJwtGuard — без токена работает (canEdit/canDelete=false для всех).
   */
  @Get('posts/:id/comments')
  @UseGuards(OptionalJwtGuard)
  list(
    @Param('id') id: string,
    @Query() query: ListBlogCommentsDto,
    @Req() req: Request,
  ): Promise<BlogCommentsPage> {
    return this.service.listComments(
      id,
      query.cursor,
      query.limit,
      this.extractUserId(req),
    );
  }

  /**
   * POST /blog/posts/:id/comments.
   * JwtAuth + per-user 1/30s + 30/час (см. BlogCommentCreateRateLimitGuard).
   */
  @Post('posts/:id/comments')
  @UseGuards(JwtAuthGuard, BlogCommentCreateRateLimitGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('id') id: string,
    @Body() dto: CreateBlogCommentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BlogComment> {
    return this.service.createComment(id, req.user.id, dto.body);
  }

  /**
   * PATCH /blog/comments/:id — редактирование автором в 15-мин окне.
   */
  @Patch('comments/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBlogCommentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BlogComment> {
    return this.service.updateComment(id, req.user.id, dto.body);
  }

  /**
   * DELETE /blog/comments/:id — soft-delete; автор или админ.
   * Уже удалённый возвращается 200 OK без декремента счётчика.
   */
  @Delete('comments/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BlogComment> {
    return this.service.deleteComment(id, req.user.id);
  }

  private extractUserId(req: Request): string | null {
    const user = (req as Request & { user?: { id?: string } | null }).user;
    return user?.id ?? null;
  }
}
