import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { SavedFiltersService } from '../user/saved-filters/saved-filters.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';
import { ShareAnalysisDto } from './dto/share-analysis.dto';
import { CreateSavedFilterDto } from './dto/create-saved-filter.dto';
import { UpdateSavedFilterDto } from './dto/update-saved-filter.dto';
import {
  legacyCreateToShared,
  legacyUpdateToShared,
  toLegacyShape,
} from './saved-filter-legacy.mapper';

/**
 * KS-2924 / KS-2929 Phase A5. Sunset эндпоинтов `/analyses/filters` —
 * 90 дней с момента выкатки A5 (2026-05-13 → 2026-08-11). После этой
 * даты эндпоинты можно удалять вместе с legacy-mapper'ом, при условии
 * что Phase B3 (миграция фронта Мастерской на `/api/user/saved-filters`)
 * завершена. Формат HTTP-date — RFC 7231 §7.1.1.1.
 */
const SUNSET_DATE = 'Tue, 11 Aug 2026 00:00:00 GMT';
const SUCCESSOR_LINK =
  '</api/user/saved-filters>; rel="successor-version"';

@UseGuards(JwtAuthGuard)
@Controller('analyses')
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    /** KS-2929: legacy /analyses/filters делегирует в новый сервис. */
    private readonly savedFiltersService: SavedFiltersService,
  ) {}

  @Post()
  create(@Request() req: AuthenticatedRequest, @Body() dto: CreateAnalysisDto) {
    return this.analysisService.create(req.user.id, dto);
  }

  @Get()
  findAll(@Request() req: AuthenticatedRequest) {
    return this.analysisService.findAll(req.user.id);
  }

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

  // ---- Saved Filters (DEPRECATED — KS-2929) ----------------------
  // Legacy proxy на `SavedFiltersService` (/api/user/saved-filters).
  // На каждый ответ выставляются заголовки Sunset/Deprecation/Link
  // (RFC 8594 + RFC 7234), чтобы клиенты могли отследить депрекейт.
  // Удаляется после фазы B3 (миграция фронта Мастерской).

  @Get('filters')
  @Header('Sunset', SUNSET_DATE)
  @Header('Deprecation', 'true')
  @Header('Link', SUCCESSOR_LINK)
  async getFilters(@Request() req: AuthenticatedRequest) {
    const list = await this.savedFiltersService.list(req.user.id, 'workshop');
    return list.map((dto) => toLegacyShape(req.user.id, dto));
  }

  @Post('filters')
  @Header('Sunset', SUNSET_DATE)
  @Header('Deprecation', 'true')
  @Header('Link', SUCCESSOR_LINK)
  async createFilter(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateSavedFilterDto,
  ) {
    const created = await this.savedFiltersService.create(
      req.user.id,
      legacyCreateToShared(dto),
    );
    return toLegacyShape(req.user.id, created);
  }

  @Patch('filters/:filterId')
  @Header('Sunset', SUNSET_DATE)
  @Header('Deprecation', 'true')
  @Header('Link', SUCCESSOR_LINK)
  async updateFilter(
    @Request() req: AuthenticatedRequest,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body() dto: UpdateSavedFilterDto,
  ) {
    const updated = await this.savedFiltersService.update(
      req.user.id,
      filterId,
      legacyUpdateToShared(dto),
    );
    return toLegacyShape(req.user.id, updated);
  }

  @Delete('filters/:filterId')
  @Header('Sunset', SUNSET_DATE)
  @Header('Deprecation', 'true')
  @Header('Link', SUCCESSOR_LINK)
  removeFilter(
    @Request() req: AuthenticatedRequest,
    @Param('filterId', ParseUUIDPipe) filterId: string,
  ) {
    return this.savedFiltersService.remove(req.user.id, filterId);
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
