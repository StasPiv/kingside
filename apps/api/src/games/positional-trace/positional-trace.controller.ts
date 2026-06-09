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
 * KS-4023 / ADR-122 §3. REST для позиционной аналитики партии.
 *
 *   - `GET  /games/:gameId/positional-trace?v=<sfVersion>` — публично.
 *   - `POST /games/:gameId/positional-trace` — JwtAuthGuard.
 *   - `DELETE /games/:gameId/positional-trace` — JwtAuthGuard + проверка
 *     прав внутри сервиса (владелец партии или админ).
 *
 * Контроллер тонкий: только маршрутизация + auth/guard + DTO-валидация.
 * Всё остальное — в `PositionalTraceService`.
 */
@Controller('games/:gameId/positional-trace')
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
    @Param('gameId', new ParseUUIDPipe()) gameId: string,
    @Query() query: PositionalTraceGetQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const trace = await this.service.getOrThrow(gameId, query.v);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return trace;
  }

  /**
   * POST — UPSERT по gameId. 201 при первом сохранении, 200 при
   * перезаписи. Тело — `PositionalTraceUpsertDto` (см. DTO).
   */
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @Post()
  async post(
    @Param('gameId', new ParseUUIDPipe()) gameId: string,
    @Body() body: PositionalTraceUpsertDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const userId = req.user?.id ?? null;
    const { trace, wasCreated } = await this.service.upsert(
      gameId,
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
    @Param('gameId', new ParseUUIDPipe()) gameId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      // По идее JwtAuthGuard уже отсёк, но дублирующая защита.
      throw new Error('Unauthenticated request reached delete handler');
    }
    await this.service.deleteByGame(gameId, userId);
  }
}
