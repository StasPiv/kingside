/**
 * KS-4409 / ADR-137 rev2. Публичные маршруты блога. Все эндпоинты
 * без авторизации — статьи публичны.
 *
 * KS-4469 / ADR-140 T3: `POST /blog/posts/:id/view` — учёт просмотра
 * с Redis-дедупом и антибот-фильтром.
 * KS-4470 / ADR-140 T4: `POST/DELETE /blog/posts/:id/like` —
 * идемпотентные лайки под `JwtAuthGuard` + per-user rate-limit.
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { BlogService } from './blog.service';
import { BlogViewService } from './blog-view.service';
import { BlogLikeService } from './blog-like.service';
import { ListBlogPostsDto } from './dto/list-blog-posts.dto';
import { GetBlogPostDto } from './dto/get-blog-post.dto';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  RedisRateLimitGuard,
  RateLimit,
} from '../common/redis-rate-limit.guard';
import {
  UserRateLimitGuard,
  UserRateLimit,
} from '../common/user-rate-limit.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import type {
  BlogLikeResponse,
  BlogViewResponse,
} from '@kingside/shared';

@Controller('blog')
export class BlogController {
  constructor(
    private readonly service: BlogService,
    private readonly viewService: BlogViewService,
    private readonly likeService: BlogLikeService,
  ) {}

  /**
   * GET /blog/posts?locale=ru&page=1&tag=...
   * KS-4472 / ADR-140 T6: `OptionalJwtGuard` — без токена работает,
   *   но при валидном JWT в `likedByMe` приходят реальные значения
   *   (batched IN-query по `blog_post_likes`).
   */
  @Get('posts')
  @UseGuards(OptionalJwtGuard)
  list(@Query() query: ListBlogPostsDto, @Req() req: Request) {
    return this.service.listPosts(query, this.extractUserId(req));
  }

  /**
   * GET /blog/posts/:slug?locale=ru
   * KS-4472 / ADR-140 T6: `OptionalJwtGuard` — для авторизованного
   *   `likedByMe` берётся из `blog_post_likes` по PK (postId, userId).
   */
  @Get('posts/:slug')
  @UseGuards(OptionalJwtGuard)
  get(
    @Param('slug') slug: string,
    @Query() query: GetBlogPostDto,
    @Req() req: Request,
  ) {
    return this.service.getPost(slug, query.locale, this.extractUserId(req));
  }

  /**
   * KS-4469 / ADR-140 §2.2.
   * POST /blog/posts/:id/view — учёт просмотра статьи.
   *
   * - `OptionalJwtGuard`: если запрос авторизован, в `req.user.id` есть
   *   userId — он используется как ключ дедупа; для гостя берётся
   *   sha1(ip + UA).
   * - `RedisRateLimitGuard @RateLimit(30, 60)`: per-IP лимит 30/60с —
   *   защита от цикла из шелла.
   * - Бот-UA и чужой Origin/Referer → 200 OK без инкремента
   *   (`counted: false`), реальный счётчик возвращаем без изменений.
   * - Возвращает `BlogViewResponse` — фронт обновляет UI без второго GET.
   *
   * Маршрут пишет в БД (`UPDATE views_count`), но семантически —
   * idempotent в окне дедупа: повтор в течение 24ч не меняет состояние.
   * Поэтому статус явно 200 OK (а не 201 Created), как в ADR.
   */
  @Post('posts/:id/view')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
  @RateLimit(30, 60)
  view(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<BlogViewResponse> {
    return this.viewService.registerView({
      postId: id,
      userId: this.extractUserId(req),
      ip: this.extractIp(req),
      userAgent: this.extractUserAgent(req),
      origin: this.extractHeader(req, 'origin'),
      referer: this.extractHeader(req, 'referer'),
    });
  }

  /**
   * KS-4470 / ADR-140 §2.1.
   * POST /blog/posts/:id/like — поставить лайк.
   *
   * Идемпотентный: повторный вызов того же пользователя по тому же
   * посту не инкрементит счётчик, но возвращает актуальный
   * `likesCount` и `likedByMe:true`. Реализация — INSERT … ON CONFLICT
   * DO NOTHING RETURNING + UPDATE likes_count в одной транзакции.
   *
   * `UserRateLimitGuard @UserRateLimit(20, 60)` — per-user 20/60с, чтобы
   * закрыть зацикленные `like → unlike → like` от одного пользователя.
   */
  @Post('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRateLimitGuard)
  @UserRateLimit(20, 60)
  like(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BlogLikeResponse> {
    return this.likeService.like(id, req.user.id);
  }

  /**
   * KS-4470 / ADR-140 §2.1.
   * DELETE /blog/posts/:id/like — снять лайк.
   *
   * Идемпотентный: повторный вызов без лайка не декрементит счётчик.
   * Защита от ухода в минус — `GREATEST(likes_count - 1, 0)` прямо в
   * SQL UPDATE. Реализация — DELETE … RETURNING + UPDATE likes_count в
   * одной транзакции.
   */
  @Delete('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserRateLimitGuard)
  @UserRateLimit(20, 60)
  unlike(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BlogLikeResponse> {
    return this.likeService.unlike(id, req.user.id);
  }

  /** GET /blog/authors/:handle */
  @Get('authors/:handle')
  author(@Param('handle') handle: string) {
    return this.service.getAuthor(handle);
  }

  // ─── helpers (Request → ViewRequestContext) ──────────────────────

  private extractUserId(req: Request): string | null {
    // OptionalJwtGuard кладёт passport-payload в req.user. У авторизованного
    // в payload есть `id` (см. JwtStrategy). У гостя req.user === null.
    const user = (req as Request & { user?: { id?: string } | null }).user;
    return user?.id ?? null;
  }

  private extractIp(req: Request): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private extractUserAgent(req: Request): string {
    const ua = req.headers['user-agent'];
    return typeof ua === 'string' ? ua : '';
  }

  private extractHeader(req: Request, name: string): string | null {
    const v = req.headers[name];
    if (typeof v === 'string' && v.length > 0) return v;
    return null;
  }
}
