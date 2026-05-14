import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { StudyService, type StudyDto } from './study.service';
import { StudyCatalogQueryDto } from './dto/study.dto';
import { McpTool } from '../mcp/decorators';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-2880 / ADR-060 §3.4. Каталог публичных студий.
 *
 * Read-only эндпоинт; ранее был полностью anonymous (без guards), но
 * с KS-2994 / ADR-060 §3.4 K4 каталог отдаёт `likedByMe: boolean` —
 * POV текущего пользователя. Поэтому добавлен `OptionalJwtAuthGuard`:
 *  - anonymous допускается (auth-токен не обязателен), `likedByMe`
 *    всегда `false`;
 *  - auth user — `likedByMe` вычисляется по `study_likes`.
 *
 * CDN-кеш: для anonymous-обращений (без `Authorization`/JWT-куки)
 * ответ детерминирован и кешируется как раньше; для auth-обращений
 * — формально per-user, в MVP без edge-кеша (см. ADR-060 §6 — кеш
 * stale-only для anon).
 *
 * Контракт: `GET /api/studies/catalog?sort=hot|new|updated|popular
 * &q=&topic=&page=&pageSize=` → `{items, total, hasMore}`.
 */
@Controller('studies/catalog')
export class StudyCatalogController {
  constructor(private readonly study: StudyService) {}

  @McpTool({
    name: 'studies__catalog',
    description:
      'Каталог публичных студий с фильтрами и сортировкой (hot/new/' +
      'updated/popular), поиск по `q`, фильтр по `topic`. Возвращает ' +
      '{items, total, hasMore}.',
    defaultLimit: 20,
    maxLimit: 50,
  })
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async catalog(
    @Request() req: AuthenticatedRequest,
    @Query() query: StudyCatalogQueryDto,
  ): Promise<{ items: StudyDto[]; total: number; hasMore: boolean }> {
    return this.study.catalog(req.user?.id ?? null, query);
  }
}
