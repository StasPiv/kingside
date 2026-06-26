/**
 * KS-4672. Разовая admin-операция: пересборка `bodyHtml` всех блог-
 * постов из их актуального `bodyMd`. Нужна после правок `markdown.ts`
 * (новые HAST-свойства / sanitize-схема) — без неё кэшированный HTML
 * в БД не получит изменений до следующего `PATCH` на каждый пост.
 *
 * Защита — `X-Admin-Token` == env `BROADCAST_ADMIN_TOKEN`, единая с
 * другими operator-эндпоинтами:
 *   - `POST /admin/prerender/reindex/all` (KS-4227)
 *   - `POST /admin/prerender/reindex/broadcasts` (KS-4221)
 *   - `POST /admin/sitemap/regenerate` (KS-4233)
 *
 * Намеренно НЕ под `AdminOrServiceGuard` (как остальные методы
 * `BlogAdminController`): сюда не ходит маркетинг через
 * service-account `blog:write`. Это операторская one-shot операция,
 * как `reindex/all`, и token хранится в том же месте (ECS task-def
 * env `BROADCAST_ADMIN_TOKEN`). Унификация с reindex/sitemap-admin —
 * сознательная.
 *
 * Идемпотентна: посты с уже актуальным HTML не апдейтятся (см.
 * сравнение в `BlogAdminService.recomputeHtmlForAllPosts`).
 */

import {
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlogAdminService } from './blog-admin.service';

@Controller('admin/blog/posts')
export class BlogAdminRecomputeController {
  private readonly logger = new Logger(BlogAdminRecomputeController.name);

  constructor(
    private readonly admin: BlogAdminService,
    private readonly config: ConfigService,
  ) {}

  @Post('recompute-html')
  async recomputeHtml(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{ total: number; updated: number; unchanged: number }> {
    this.assertAuth(token);
    this.logger.log('[blog-recompute] manual recompute triggered');
    const result = await this.admin.recomputeHtmlForAllPosts();
    this.logger.log(
      `[blog-recompute] done: total=${result.total} updated=${result.updated} unchanged=${result.unchanged}`,
    );
    return result;
  }

  private assertAuth(token: string | undefined): void {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      this.logger.error(
        '[blog-recompute] BROADCAST_ADMIN_TOKEN is not configured — endpoint disabled',
      );
      throw new HttpException(
        'admin endpoint is not configured (BROADCAST_ADMIN_TOKEN missing)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!token || token !== expected) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN);
    }
  }
}
