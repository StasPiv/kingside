import { Controller, Get, Param, ParseUUIDPipe, Query, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { StudyService, type StudyDto } from './study.service';
import { StudyByUserQueryDto } from './dto/study.dto';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { McpTool } from '../mcp/decorators';

/**
 * KS-2881 / ADR-060 §2.8 K6. Список студий конкретного пользователя.
 *
 * Endpoint: `GET /api/studies/by/:userId?page=&pageSize=&includePrivate=`.
 *
 * Вынесен в отдельный контроллер с префиксом `studies/by`, чтобы:
 *  - не пересекаться с параметрическим `:slug` в `StudyController`
 *    (NestJS приоритизирует статические сегменты, но порядок-в-коде
 *    делает поведение детерминированным);
 *  - сохранить `OptionalJwtAuthGuard` — anonymous допускается, auth
 *    раскрывает дополнительные права (self → includePrivate);
 *  - не наследовать `StudyAccessGuard`/`StudyOwnerGuard` из основного
 *    контроллера (они для конкретной студии по slug, не для листинга).
 *
 * Response: `{ items: StudyDto[], total, hasMore, owner: {id, username} }`.
 */
@Controller('studies/by')
export class StudyByUserController {
  constructor(private readonly study: StudyService) {}

  @McpTool({
    name: 'studies__by_user',
    description:
      'Список студий конкретного пользователя (по id). Anonymous и ' +
      'auth-other видят только public; auth-self с includePrivate=1 ' +
      'видит свои private/unlisted тоже. Сортировка updatedAt DESC.',
    defaultLimit: 20,
    maxLimit: 50,
  })
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':userId')
  async listByUser(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: StudyByUserQueryDto,
  ): Promise<{
    items: StudyDto[];
    total: number;
    hasMore: boolean;
    owner: { id: string; username: string | null };
  }> {
    return this.study.listByUser(req.user?.id ?? null, userId, query);
  }
}
