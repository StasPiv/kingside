import {
  Controller,
  Get,
  Put,
  Body,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserPreferencesService } from './user-preferences.service';
import { ArchiveFiltersDto } from './dto/archive-filters.dto';
import { AuthenticatedRequest } from '../common/authenticated-request';
import type { ArchiveFiltersResponse } from '@kingside/shared';

/**
 * Эндпоинты пользовательских предпочтений (KS-2210).
 *
 * Пути:
 *   GET  /api/user/preferences/archive-filters — получить фильтры архива
 *   PUT  /api/user/preferences/archive-filters — сохранить фильтры архива
 *
 * Все эндпоинты требуют JWT-аутентификации.
 */
@Controller('user/preferences')
@UseGuards(JwtAuthGuard)
export class UserPreferencesController {
  constructor(private readonly preferences: UserPreferencesService) {}

  /** GET /api/user/preferences/archive-filters */
  @Get('archive-filters')
  async getArchiveFilters(
    @Request() req: AuthenticatedRequest,
  ): Promise<ArchiveFiltersResponse> {
    const filters = await this.preferences.getArchiveFilters(req.user.id);
    return { filters };
  }

  /** PUT /api/user/preferences/archive-filters */
  @Put('archive-filters')
  @HttpCode(HttpStatus.OK)
  async saveArchiveFilters(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ArchiveFiltersDto,
  ): Promise<ArchiveFiltersResponse> {
    const filters = await this.preferences.saveArchiveFilters(req.user.id, dto);
    return { filters };
  }
}
