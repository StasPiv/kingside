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
