import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../../common/authenticated-request';
import {
  PositionalTraceGetQueryDto,
  PositionalTraceUpsertDto,
} from './dto/positional-trace.dto';
import { PositionalTraceService } from './positional-trace.service';

/**
 * KS-4026 / ADR-122 §3. REST для позиционной аналитики анализа.
 *
 *   - `GET  /analyses/:analysisId/positional-trace?v=<sfVersion>` — публично.
 *   - `POST /analyses/:analysisId/positional-trace` — JwtAuthGuard.
 *   - `DELETE /analyses/:analysisId/positional-trace` — JwtAuthGuard +
 *     проверка прав внутри сервиса (владелец анализа или админ).
 *
 * Переезд с `gameId` (KS-4023): см. описание KS-4026 — в реальном
 * потоке пользователя `gameId` почти всегда отсутствует, ключом
 * хранения теперь служит `analysisId`.
 *
 * Контроллер тонкий: только маршрутизация + auth/guard + DTO-валидация.
 * Всё остальное — в `PositionalTraceService`.
 */
@Controller('analyses/:analysisId/positional-trace')
export class PositionalTraceController {
  constructor(private readonly service: PositionalTraceService) {}

  /**
   * GET — возвращает запись, если версия совпала. Иначе 404
   * `positional_trace_not_found` (см. ADR-122 §3.1).
   *
   * Кеш-контроль: 5 минут на стороне клиента; инвалидация при
   * следующем POST/DELETE происходит обычным «на следующее открытие
   * страницы» — отдельного механизма purge нет.
   */
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @Get()
  async get(
    @Param('analysisId', new ParseUUIDPipe()) analysisId: string,
    @Query() query: PositionalTraceGetQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const trace = await this.service.getOrThrow(analysisId, query.v);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return trace;
  }

  /**
   * POST — UPSERT по analysisId. 201 при первом сохранении, 200 при
   * перезаписи. Тело — `PositionalTraceUpsertDto`.
   */
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @Post()
  async post(
    @Param('analysisId', new ParseUUIDPipe()) analysisId: string,
    @Body() body: PositionalTraceUpsertDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const userId = req.user?.id ?? null;
    const { trace, wasCreated } = await this.service.upsert(
      analysisId,
      userId,
      body,
    );
    res.status(wasCreated ? HttpStatus.CREATED : HttpStatus.OK);
    return trace;
  }

  /**
   * DELETE — идемпотентно. 204 независимо от того, была ли запись.
   * Проверка прав (владелец / админ) внутри сервиса.
   */
  @UseGuards(JwtAuthGuard)
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('analysisId', new ParseUUIDPipe()) analysisId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('Unauthenticated request reached delete handler');
    }
    await this.service.deleteByAnalysis(analysisId, userId);
  }
}
