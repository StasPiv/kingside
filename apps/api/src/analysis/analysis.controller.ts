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
import { SavedFilterService } from './saved-filter.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';
import { CreateSavedFilterDto } from './dto/create-saved-filter.dto';
import { UpdateSavedFilterDto } from './dto/update-saved-filter.dto';

@UseGuards(JwtAuthGuard)
@Controller('analyses')
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly savedFilterService: SavedFilterService,
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

  // ---- Saved Filters ----

  @Get('filters')
  getFilters(@Request() req: AuthenticatedRequest) {
    return this.savedFilterService.findAll(req.user.id);
  }

  @Post('filters')
  createFilter(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateSavedFilterDto,
  ) {
    return this.savedFilterService.create(req.user.id, dto);
  }

  @Patch('filters/:filterId')
  updateFilter(
    @Request() req: AuthenticatedRequest,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body() dto: UpdateSavedFilterDto,
  ) {
    return this.savedFilterService.update(req.user.id, filterId, dto);
  }

  @Delete('filters/:filterId')
  removeFilter(
    @Request() req: AuthenticatedRequest,
    @Param('filterId', ParseUUIDPipe) filterId: string,
  ) {
    return this.savedFilterService.remove(req.user.id, filterId);
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
  async findOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analysisService.findOne(req.user.id, id);
    // KS-2376: пользователи получали HTTP 304 на разные uuid'ы — клиент
    // показывал тело первой загруженной партии при открытии любой другой.
    // Дефолтный weak-ETag Express'а оказался ненадёжен (вероятно, кэш
    // SW/CDN/прокси переиспользовал If-None-Match между разными URL'ами).
    //
    // Лекарство:
    //   1. Жёстко привязываем ETag к конкретному ресурсу — `id + updated_at`.
    //      Любой If-None-Match от другого ресурса гарантированно не
    //      совпадёт, сервер вернёт 200 + правильное тело.
    //   2. Cache-Control: private, no-cache, must-revalidate — приватный
    //      кэш (на пользователя), браузер всегда revalidate с If-None-Match,
    //      stale-ответы запрещены. Public-CDN не кэширует.
    const ts =
      data.updatedAt instanceof Date
        ? data.updatedAt.getTime()
        : new Date(data.updatedAt as unknown as string).getTime();
    res.setHeader('ETag', `W/"analysis-${id}-${ts}"`);
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    return data;
  }

  @Put(':id')
  update(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnalysisDto,
  ) {
    return this.analysisService.update(req.user.id, id, dto);
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
