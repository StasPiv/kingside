/**
 * KS-4674 / ADR-146. Админский CRUD дебютных репертуаров (демо-набор,
 * `is_demo=true`). По образцу `BlogAdminController` (ADR-137 rev2):
 * единый `AdminOrServiceGuard` (JWT-админ ИЛИ service-account),
 * mutating-эндпоинты требуют `@RequiredScope(SCOPES.REPERTOIRE_WRITE)`,
 * read-эндпоинты без scope.
 *
 * Пользовательские репертуары (`is_demo=false`) обслуживает старый
 * `OpeningTrainerController` под `JwtAuthGuard` — этот контроллер их
 * не трогает.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminOrServiceGuard } from '../../auth/admin-or-service.guard';
import { RequiredScope } from '../../auth/required-scope.decorator';
import { SCOPES } from '../../auth/scopes';
import {
  CreateAdminRepertoireDto,
  UpdateAdminRepertoireDto,
  UpdateAdminRepertoireStatusDto,
} from './admin-opening-repertoire.dto';
import {
  type AdminRepertoireDetail,
  type AdminRepertoireSummary,
  OpeningTrainerAdminService,
} from './opening-trainer-admin.service';

@UseGuards(AdminOrServiceGuard)
@Controller('admin/opening-trainer/repertoires')
export class OpeningTrainerAdminController {
  constructor(private readonly admin: OpeningTrainerAdminService) {}

  @Get()
  list(
    @Query('side') side?: 'white' | 'black',
    @Query('slug') slug?: string,
    @Query('isPublished', new ParseBoolPipe({ optional: true }))
    isPublished?: boolean,
  ): Promise<AdminRepertoireSummary[]> {
    return this.admin.list({ side, slug, isPublished });
  }

  @Get(':id')
  getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminRepertoireDetail> {
    return this.admin.getById(id);
  }

  @Post()
  @RequiredScope(SCOPES.REPERTOIRE_WRITE)
  create(@Body() body: CreateAdminRepertoireDto): Promise<AdminRepertoireDetail> {
    return this.admin.create(body);
  }

  @Put(':id')
  @RequiredScope(SCOPES.REPERTOIRE_WRITE)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAdminRepertoireDto,
  ): Promise<AdminRepertoireDetail> {
    return this.admin.update(id, body);
  }

  @Patch(':id/status')
  @RequiredScope(SCOPES.REPERTOIRE_WRITE)
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAdminRepertoireStatusDto,
  ): Promise<AdminRepertoireDetail> {
    return this.admin.setStatus(id, body);
  }

  @Delete(':id')
  @RequiredScope(SCOPES.REPERTOIRE_WRITE)
  @HttpCode(204)
  async delete(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.admin.delete(id);
  }
}
