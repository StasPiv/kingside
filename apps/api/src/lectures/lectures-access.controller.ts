import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { LecturesAccessService } from './lectures-access.service';
import { AddLectureAccessDto } from './dto/lecture-access.dto';

/**
 * KS-3936 / ADR-118 §2.4.1. Owner-only REST API для управления
 * allowlist'ом restricted-лекций.
 *
 *   GET    /lectures/:id/access           — список grant'ов (с user-info).
 *   POST   /lectures/:id/access           — bulk add (idempotent).
 *   DELETE /lectures/:id/access/:userId   — revoke (idempotent, 204).
 *
 * Все эндпоинты под `JwtAuthGuard`. Owner-проверка делается внутри
 * сервиса (`loadOwnedLecture`) — 404 если лекции нет, 403 если
 * `req.user.id !== lecture.ownerId`.
 *
 * Контроллер вынесен отдельным файлом от `LecturesController`,
 * потому что:
 *   - префикс пути общий (`lectures/:id/access*`), удобнее держать
 *     рядом одного controller'а;
 *   - все три endpoint'а require JWT-only и owner-checks (одинаковая
 *     политика), в `LecturesController` смешаны public-getById и
 *     owner-operations — лишняя сложность.
 *
 * Future:
 *   - KS-3940 C01 повесит на DELETE публикацию Redis-события
 *     `lecture-access-revoked` для disconnect'а зрителей в live.
 *   - KS-3938 B03 добавит `GET /users/search` для UI «найти ученика».
 */
@Controller('lectures/:id/access')
@UseGuards(JwtAuthGuard)
export class LecturesAccessController {
  constructor(private readonly access: LecturesAccessService) {}

  @Get()
  async list(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.access.listGrants(id, req.user.id);
  }

  @Post()
  async add(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddLectureAccessDto,
  ) {
    return this.access.addGrants(id, req.user.id, dto.userIds);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.access.revokeGrant(id, req.user.id, userId);
  }
}
