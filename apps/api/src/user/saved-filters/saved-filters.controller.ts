import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { SavedFilterDto } from '@kingside/shared';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../../common/authenticated-request';
import { SavedFiltersService } from './saved-filters.service';
import {
  CreateSavedFilterDto,
  SavedFiltersListQueryDto,
  UpdateSavedFilterDto,
} from './dto/saved-filters.dto';

/**
 * KS-2924 / KS-2927 Phase A3. REST для сохранённых фильтров.
 *
 * Пути:
 *   GET    /api/user/saved-filters?section=workshop|archive
 *   POST   /api/user/saved-filters
 *   PATCH  /api/user/saved-filters/:id
 *   DELETE /api/user/saved-filters/:id
 *
 * Все эндпоинты — JWT, scoped по `req.user.id`.
 *
 * Старый эндпоинт `/api/saved-filters` (apps/api/src/analysis) пока
 * сосуществует — удаляется в Phase A5 после переезда фронта.
 */
@Controller('user/saved-filters')
@UseGuards(JwtAuthGuard)
export class SavedFiltersController {
  constructor(private readonly service: SavedFiltersService) {}

  @Get()
  async list(
    @Request() req: AuthenticatedRequest,
    @Query() query: SavedFiltersListQueryDto,
  ): Promise<SavedFilterDto[]> {
    return this.service.list(req.user.id, query.section);
  }

  @Post()
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateSavedFilterDto,
  ): Promise<SavedFilterDto> {
    return this.service.create(req.user.id, dto);
  }

  @Patch(':id')
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSavedFilterDto,
  ): Promise<SavedFilterDto> {
    return this.service.update(req.user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: true }> {
    return this.service.remove(req.user.id, id);
  }
}
