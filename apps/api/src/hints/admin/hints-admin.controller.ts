/**
 * KS-4702 / ADR-147 §3.3. Admin CRUD `/admin/hints/*`.
 *
 * По образцу OpeningTrainerAdminController / BlogAdminController:
 *   - `AdminOrServiceGuard` на классе — пропускает либо JWT-админа,
 *     либо service-account.
 *   - Read-эндпоинты без scope, mutating — под `@RequiredScope
 *     (SCOPES.HINTS_WRITE)` ('hints:write').
 *
 * Endpoints:
 *   - `GET   /admin/hints` — список с фильтрами.
 *   - `GET   /admin/hints/:id` — детали.
 *   - `POST  /admin/hints` — создать (валидация DSL + sanitize i18n).
 *   - `PUT   /admin/hints/:id` — обновить (частично, по образцу blog).
 *   - `PATCH /admin/hints/:id/status` — публикация/скрытие (re-enable
 *     auto-сбрасывает `deletedAt` — это и есть restore).
 *   - `DELETE /admin/hints/:id` — soft-delete (`deletedAt=now()`).
 *   - `POST  /admin/hints/preview-trigger` — оценка покрытия DSL.
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
  CreateHintDto,
  PreviewTriggerDto,
  UpdateHintDto,
  UpdateHintStatusDto,
} from './admin-hint.dto';
import {
  AdminHintDetail,
  AdminHintSummary,
  HintsAdminService,
} from './hints-admin.service';

@UseGuards(AdminOrServiceGuard)
@Controller('admin/hints')
export class HintsAdminController {
  constructor(private readonly admin: HintsAdminService) {}

  @Get()
  list(
    @Query('enabled', new ParseBoolPipe({ optional: true })) enabled?: boolean,
    @Query('anchor') anchor?: string,
    @Query('actorType') actorType?: 'user' | 'guest',
    @Query('search') search?: string,
    @Query('includeDeleted', new ParseBoolPipe({ optional: true }))
    includeDeleted?: boolean,
  ): Promise<AdminHintSummary[]> {
    return this.admin.list({
      enabled,
      anchor,
      actorType,
      search,
      includeDeleted,
    });
  }

  @Get(':id')
  getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminHintDetail> {
    return this.admin.getById(id);
  }

  @Post()
  @RequiredScope(SCOPES.HINTS_WRITE)
  create(@Body() body: CreateHintDto): Promise<AdminHintDetail> {
    return this.admin.create(body);
  }

  @Put(':id')
  @RequiredScope(SCOPES.HINTS_WRITE)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateHintDto,
  ): Promise<AdminHintDetail> {
    return this.admin.update(id, body);
  }

  @Patch(':id/status')
  @RequiredScope(SCOPES.HINTS_WRITE)
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateHintStatusDto,
  ): Promise<AdminHintDetail> {
    return this.admin.setStatus(id, body);
  }

  @Delete(':id')
  @RequiredScope(SCOPES.HINTS_WRITE)
  @HttpCode(204)
  async delete(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.admin.delete(id);
  }

  @Post('preview-trigger')
  @RequiredScope(SCOPES.HINTS_WRITE)
  preview(@Body() body: PreviewTriggerDto): Promise<{
    estimate: number;
    sampled: number;
    capped: boolean;
  }> {
    return this.admin.previewTrigger(body.rule);
  }
}
