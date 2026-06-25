/**
 * KS-4410 / ADR-137 rev2 + KS-4445 / ADR-138 §6 + KS-4457 / ADR-139 T5.
 * Админ-маршруты блога.
 *
 * Защита — единый `AdminOrServiceGuard` (KS-4455 / ADR-139 §3),
 * принимающий ДВА типа аутентификации:
 *   1. human-admin: `JwtAuthGuard` + whitelist `KS_ADMIN_USERS` (KS-2108).
 *      Все эндпоинты — human-админ может читать и менять без ограничений.
 *   2. service-account: Bearer `ks_sa_*` (KS-4454), проверка по
 *      `agent_service_accounts` + scope из `@RequiredScope`.
 *
 * Scope-политика на этом контроллере (зафиксировано в KS-4457):
 *   - mutating: `@RequiredScope('blog:write')` — POST/PUT/PATCH/DELETE
 *     для posts и authors.
 *   - read (GET `posts`, `posts/:id`, `authors`, `authors/:id`) — БЕЗ
 *     scope. Сервис-аккаунт с любым непустым scope может читать.
 *     Логика: read-эндпоинты не меняют состояние, выдача read-only
 *     scope (`blog:read`) поднимется в дизайне отдельно, если такой
 *     ограниченный агент появится.
 *   - POST `posts/preview` — рендер markdown, БД не пишется. БЕЗ scope.
 *
 * Создание и обновление статьи принимают `multipart/form-data` (см.
 * KS-4445): текстовые поля в `Body`, бинарное поле `cover` —
 * `Express.Multer.File` через `FileInterceptor`. Если файла нет —
 * приходит обычный JSON, контракт совместим.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminOrServiceGuard } from '../auth/admin-or-service.guard';
import { RequiredScope } from '../auth/required-scope.decorator';
import { BlogAdminService } from './blog-admin.service';
import {
  BlogCounterReconcileService,
  type BlogReconcileSummary,
} from './blog-counter-reconcile.service';
import {
  BlogMediaInvalidMimeError,
  BlogMediaNotConfiguredError,
  BlogMediaService,
} from './blog-media.service';
import {
  CreateBlogAuthorDto,
  CreateBlogPostDto,
  ListAdminBlogPostsDto,
  PreviewBlogMarkdownDto,
  UpdateBlogAuthorDto,
  UpdateBlogPostDto,
  UpdateBlogPostStatusDto,
} from './dto/blog-admin.dto';

/** KS-4445 / ADR-138 §6. Лимит размера файла-обложки — 5 MB. */
export const BLOG_COVER_MAX_BYTES = 5 * 1024 * 1024;

/** Whitelist MIME — копия `BlogMediaService.getAllowedMimeTypes()`,
 *  но синхронная (`@UseInterceptors` декоратор вычисляется до DI).
 *  Должен оставаться в синхроне со `BLOG_COVER_MIME_TO_EXT`. */
const BLOG_COVER_ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const COVER_INTERCEPTOR = FileInterceptor('cover', {
  limits: { fileSize: BLOG_COVER_MAX_BYTES, files: 1 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileFilter: (_req: any, file: any, cb: any) => {
    if (BLOG_COVER_ALLOWED_MIMES.has(file.mimetype as string)) {
      cb(null, true);
      return;
    }
    cb(
      new BadRequestException(
        `Unsupported cover MIME: "${file.mimetype}" (allowed: image/png, image/jpeg, image/webp)`,
      ),
      false,
    );
  },
});

/**
 * KS-4661. Multipart-приёмник для эндпоинта `POST /admin/blog/media` —
 * загрузка картинки в тело статьи (вставляется как `![alt](url)`).
 * Поле `file`, не `cover`. Лимит и whitelist MIME совпадают с
 * обложечным `COVER_INTERCEPTOR` — отдельная константа, чтобы не
 * случайно поменять одну сторону без другой.
 */
const BODY_MEDIA_INTERCEPTOR = FileInterceptor('file', {
  limits: { fileSize: BLOG_COVER_MAX_BYTES, files: 1 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileFilter: (_req: any, file: any, cb: any) => {
    if (BLOG_COVER_ALLOWED_MIMES.has(file.mimetype as string)) {
      cb(null, true);
      return;
    }
    cb(
      new BadRequestException(
        `Unsupported body image MIME: "${file.mimetype}" (allowed: image/png, image/jpeg, image/webp)`,
      ),
      false,
    );
  },
});

@UseGuards(AdminOrServiceGuard)
@Controller('admin/blog')
export class BlogAdminController {
  constructor(
    private readonly admin: BlogAdminService,
    private readonly media: BlogMediaService,
    // KS-4473 / ADR-140 T7: ручной запуск пересчёта счётчиков.
    private readonly reconciler: BlogCounterReconcileService,
  ) {}

  // ─── posts ─────────────────────────────────────────────────────────

  @Get('posts')
  listPosts(@Query() query: ListAdminBlogPostsDto) {
    return this.admin.listPosts(query);
  }

  @Get('posts/:id')
  getPost(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getPost(id);
  }

  @Post('posts')
  @RequiredScope('blog:write')
  @UseInterceptors(COVER_INTERCEPTOR)
  async createPost(
    @Body() body: CreateBlogPostDto,
    @UploadedFile() cover?: Express.Multer.File,
  ) {
    const coverUrl = await this.maybeUploadCover(body.slug, cover);
    return this.admin.createPost({
      ...body,
      ...(coverUrl != null ? { coverUrl } : {}),
    });
  }

  @Put('posts/:id')
  @RequiredScope('blog:write')
  @UseInterceptors(COVER_INTERCEPTOR)
  async updatePost(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostDto,
    @UploadedFile() cover?: Express.Multer.File,
  ) {
    // KS-4445 / ADR-138 §6. Семантика обложки на PATCH:
    //   1. Если файл `cover` пришёл — загружаем и пишем новый URL,
    //      `coverReset` игнорируется (приоритет файла).
    //   2. Иначе если `coverReset=true` — зануляем `coverUrl`/`coverAlt`.
    //   3. Иначе — не трогаем поля обложки (PATCH-семантика).
    let coverPatch: Pick<UpdateBlogPostDto, 'coverUrl' | 'coverAlt'> | null =
      null;
    if (cover) {
      // На PATCH slug может не приходить — берём slug целевого поста, либо
      // тот, что в body (если меняется одновременно).
      const slugForKey = body.slug ?? (await this.admin.getPost(id)).slug;
      const url = await this.maybeUploadCover(slugForKey, cover);
      coverPatch = { coverUrl: url };
    } else if (body.coverReset === true) {
      coverPatch = { coverUrl: null, coverAlt: null };
    }
    const merged: UpdateBlogPostDto = { ...body, ...(coverPatch ?? {}) };
    // `coverReset` не транслируется в сервисный update — он только
    // контроллер-уровневый флаг.
    delete (merged as { coverReset?: unknown }).coverReset;
    return this.admin.updatePost(id, merged);
  }

  /**
   * Загружает обложку через BlogMediaService, отдаёт URL.
   * Возвращает `null` если файл не передан. Прячет внутренние
   * ошибки media-сервиса в понятные HTTP-исключения.
   */
  private async maybeUploadCover(
    slug: string | undefined,
    cover: Express.Multer.File | undefined,
  ): Promise<string | null> {
    if (!cover) return null;
    if (!slug || slug.trim().length === 0) {
      // Без slug ключ S3 не построить. На POST slug в DTO обязателен,
      // на PATCH мы достаём slug из БД до вызова.
      throw new BadRequestException(
        'cover upload requires a slug (in body for POST or existing post for PATCH)',
      );
    }
    if (!this.media.isConfigured()) {
      throw new ServiceUnavailableException(
        'BLOG_MEDIA_* env is not configured on this instance',
      );
    }
    try {
      const { url } = await this.media.uploadCover(slug, {
        buffer: cover.buffer,
        mimetype: cover.mimetype,
        size: cover.size,
      });
      return url;
    } catch (e) {
      if (e instanceof BlogMediaInvalidMimeError) {
        throw new BadRequestException(e.message);
      }
      if (e instanceof BlogMediaNotConfiguredError) {
        throw new ServiceUnavailableException(e.message);
      }
      throw e;
    }
  }

  @Delete('posts/:id')
  @RequiredScope('blog:write')
  async deletePost(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: true }> {
    await this.admin.deletePost(id);
    return { deleted: true };
  }

  @Patch('posts/:id/status')
  @RequiredScope('blog:write')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostStatusDto,
  ) {
    return this.admin.setStatus(id, body.status);
  }

  @Post('posts/preview')
  preview(@Body() body: PreviewBlogMarkdownDto) {
    return this.admin.previewMarkdown(body.bodyMd);
  }

  /**
   * KS-4661. Разовая загрузка изображения для тела статьи блога.
   * Возвращает публичный CDN-URL, который маркетинг вставляет в
   * markdown как `![alt](url)`. Ключ не привязан к slug —
   * content-addressable, одну картинку можно использовать в нескольких
   * статьях.
   *
   * Защита та же, что у `POST posts` — `AdminOrServiceGuard` +
   * `blog:write` scope. Лимит 5 MB, MIME — PNG/JPEG/WebP.
   */
  @Post('media')
  @RequiredScope('blog:write')
  @UseInterceptors(BODY_MEDIA_INTERCEPTOR)
  async uploadBodyImage(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string; key: string }> {
    if (!file) {
      throw new BadRequestException(
        'file is required (multipart field "file")',
      );
    }
    if (!this.media.isConfigured()) {
      throw new ServiceUnavailableException(
        'BLOG_MEDIA_* env is not configured on this instance',
      );
    }
    try {
      return await this.media.uploadBodyImage({
        buffer: file.buffer,
        mimetype: file.mimetype,
        size: file.size,
      });
    } catch (e) {
      if (e instanceof BlogMediaInvalidMimeError) {
        throw new BadRequestException(e.message);
      }
      if (e instanceof BlogMediaNotConfiguredError) {
        throw new ServiceUnavailableException(e.message);
      }
      throw e;
    }
  }

  // ─── authors ───────────────────────────────────────────────────────

  @Get('authors')
  listAuthors() {
    return this.admin.listAuthors();
  }

  @Get('authors/:id')
  getAuthor(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.getAuthor(id);
  }

  @Post('authors')
  @RequiredScope('blog:write')
  createAuthor(@Body() body: CreateBlogAuthorDto) {
    return this.admin.createAuthor(body);
  }

  @Put('authors/:id')
  @RequiredScope('blog:write')
  updateAuthor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogAuthorDto,
  ) {
    return this.admin.updateAuthor(id, body);
  }

  @Delete('authors/:id')
  @RequiredScope('blog:write')
  async deleteAuthor(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: true }> {
    await this.admin.deleteAuthor(id);
    return { deleted: true };
  }

  /**
   * KS-4473 / ADR-140 T7. Ручной запуск пересчёта `likes_count` и
   * `comments_count` из COUNT(*) детальных таблиц.
   *
   * Тот же код выполняется суточным cron'ом 03:00 UTC
   * (`BlogReconcileScheduler`). Эндпоинт нужен:
   *   - проверить cron после деплоя без ожидания тика;
   *   - быстро отреставрировать счётчики после ручной правки БД.
   *
   * Защищён `AdminOrServiceGuard` + scope `blog:write` (как остальные
   * mutating-маршруты блога).
   */
  @Post('recount')
  @RequiredScope('blog:write')
  recount(): Promise<BlogReconcileSummary> {
    return this.reconciler.reconcileAll();
  }

  /**
   * KS-4616. Разовая перепостановка prerender-задач по всем
   * опубликованным статьям блога — наполняет
   * `s3://kingside-prerender-store/{locale}/blog/` после выкатки.
   * Идемпотентна (воркер перезаписывает существующие S3-ключи),
   * вызывать можно повторно. Защищена `blog:write` scope как
   * остальные mutating-маршруты.
   */
  @Post('prerender/reindex')
  @RequiredScope('blog:write')
  reindexPrerender(): Promise<{
    enqueued: number;
    posts: Array<{ slug: string; locale: 'ru' | 'en' }>;
  }> {
    return this.admin.reindexPrerenderForPublished();
  }
}
