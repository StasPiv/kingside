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
