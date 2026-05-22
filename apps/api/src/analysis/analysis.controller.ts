import { AuthenticatedRequest } from '../common/authenticated-request';
import {
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
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalysisService } from './analysis.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';
import { ShareAnalysisDto } from './dto/share-analysis.dto';
import { CheckExistingDto } from './dto/check-existing.dto';
import { McpTool } from '../mcp/decorators';

/**
 * KS-2924 / KS-2943 Phase D1. Legacy proxy `/analyses/filters`
 * полностью удалён — фронт Мастерской переехал на
 * `/api/user/saved-filters` (KS-2933/KS-2931). См. историю
 * в KS-2929 (A5: депрекейт) и KS-2940 (unique-индекс).
 */
@UseGuards(JwtAuthGuard)
@Controller('analyses')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post()
  create(@Request() req: AuthenticatedRequest, @Body() dto: CreateAnalysisDto) {
    return this.analysisService.create(req.user.id, dto);
  }

  /**
   * KS-3261. Bulk-check «уже в мастерской». Для архив-карточек и broadcast-
   * списков: фронт собирает Lichess game-id'ы и/или наш archive game-id'ы
   * партий на странице и спрашивает у backend — на какие из них у юзера
   * уже есть анализ. Возвращает map sourceId → analysisId | null.
   *
   * Объявлен ДО `@Get(':id')` чтобы статический сегмент `check` матчился
   * раньше параметрического (Nest сам предпочитает статические, но
   * порядок объявления делает поведение детерминированным).
   */
  @Post('check')
  check(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CheckExistingDto,
  ): Promise<{
    lichess: Record<string, string | null>;
    archive: Record<string, string | null>;
  }> {
    return this.analysisService.checkExistingBySource(req.user.id, {
      lichessGameIds: dto.lichessGameIds,
      archiveGameIds: dto.archiveGameIds,
    });
  }

  // KS-2948: список анализов пользователя.
  //  - дефолтный limit=20, верхний потолок 100 (защита от 200КБ tool_result
  //    в MCP-обёртке `tools/mcp-kingside.mjs::getUserAnalyses`);
  //  - `offset` для пагинации;
  //  - `withPgn=true` опционально включает `pgn`/`fen` в каждой записи
  //    (по умолчанию список содержит только метаданные).
  // KS-2953 (ADR-061 этап B): подсказки для MCP-сервера.
  // `excludeFields` страховка — если фронт когда-то начнёт слать
  // `?withPgn=true` через ассистента, MCP вырежет тяжёлые поля.
  @McpTool({
    name: 'analyses__list',
    description:
      'Список анализов партий текущего пользователя (метаданные, без PGN). ' +
      'Для конкретной партии с PGN — analyses__find_one.',
    defaultLimit: 20,
    maxLimit: 100,
    excludeFields: ['[].pgn', '[].fen', '[].currentPosition'],
  })
  @Get()
  findAll(
    @Request() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('withPgn') withPgn?: string,
    // KS-3203: подстрока для ILIKE по headline/title/opening/event/
    // white/black/site/tags. Drop-in замена для frontend-loop'а из
    // KS-3202.
    @Query('search') search?: string,
  ) {
    return this.analysisService.findAll(req.user.id, {
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
      offset: offset !== undefined ? parseInt(offset, 10) : undefined,
      withPgn: withPgn === 'true' || withPgn === '1',
      search,
    });
  }

  @McpTool({
    name: 'analyses__search',
    description:
      'Поиск среди анализов пользователя по подстроке в заголовках/' +
      'дебюте/именах игроков. Только метаданные.',
    defaultLimit: 20,
    maxLimit: 50,
  })
  @Get('search')
  search(
    @Request() req: AuthenticatedRequest,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    return this.analysisService.search(
      req.user.id,
      q || '',
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Post('export')
  async exportPgn(
    @Request() req: AuthenticatedRequest,
    @Body('ids') ids: string[],
    @Res() res: Response,
  ) {
    const pgn = await this.analysisService.exportPgn(req.user.id, ids ?? []);
    res.setHeader('Content-Type', 'application/x-chess-pgn');
    res.setHeader('Content-Disposition', 'attachment; filename="analyses.pgn"');
    res.send(pgn);
  }

  @Get(':id')
  findOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analysisService.findOne(req.user.id, id);
  }

  @Put(':id')
  update(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnalysisDto,
  ) {
    return this.analysisService.update(req.user.id, id, dto);
  }

  // KS-2602 (ADR-051 §3 share-3): toggle публичности анализа автором.
  // Объявлен ДО `@Patch(':id')`, чтобы статический сегмент `share`
  // матчился раньше параметрического `:id` (на всякий случай — Nest
  // и так предпочитает статические сегменты, но порядок объявления
  // делает поведение детерминированным).
  @Patch(':id/share')
  share(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShareAnalysisDto,
  ) {
    return this.analysisService.share(req.user.id, id, dto.isPublic);
  }

  @Patch(':id')
  patch(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnalysisDto,
  ) {
    return this.analysisService.update(req.user.id, id, dto);
  }

  @Delete(':id')
  remove(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analysisService.remove(req.user.id, id);
  }
}
