/**
 * KS-4803. `GET /admin/hints-diagnose` — read-only диагностика hints
 * pipeline для произвольного actor'а. Симметричен `/admin/events`
 * (KS-4801): один query-параметр `actorId` (UUID), опционально
 * `actorType` (default `'user'`) и `hintId` (сужает выборку state'ов).
 *
 * Защита — `AdminOrServiceGuard`:
 *   - JWT-admin (`KS_ADMIN_USERS`) — без scope-проверки;
 *   - service-account обязан иметь scope `hints:read` (`SCOPES.HINTS_READ`).
 *
 * Контракт response — см. `HintsDiagnoseService.diagnose()`.
 */
import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AdminOrServiceGuard } from '../../auth/admin-or-service.guard';
import { RequiredScope } from '../../auth/required-scope.decorator';
import { SCOPES } from '../../auth/scopes';
import { HintsDiagnoseQueryDto } from './dto/hints-diagnose-query.dto';
import {
  HintsDiagnoseService,
  type HintsDiagnoseResult,
} from './hints-diagnose.service';

@Controller('admin/hints-diagnose')
@UseGuards(AdminOrServiceGuard)
export class HintsDiagnoseController {
  constructor(private readonly diagnose: HintsDiagnoseService) {}

  @Get()
  @RequiredScope(SCOPES.HINTS_READ)
  // Глобальный pipe не в transform-режиме (см. main.ts:86), локальный
  // override — чтобы actorType lower-case-нормализация из DTO применилась.
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }))
  async run(
    @Query() query: HintsDiagnoseQueryDto,
  ): Promise<HintsDiagnoseResult> {
    return this.diagnose.diagnose(
      { type: query.actorType ?? 'user', id: query.actorId },
      query.hintId,
    );
  }

  /**
   * KS-4810 follow-up. `POST /admin/hints-diagnose/reset` — снять
   * `hints:throttle:<actor>` и все `hints:session:<actor>:<date>`.
   * `events.actor_hint_states` НЕ трогается (per-hint maxShows /
   * cooldown сохраняются — это история, не runtime). Idempotent.
   */
  @Post('reset')
  @RequiredScope(SCOPES.HINTS_READ)
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }))
  async reset(
    @Query() query: HintsDiagnoseQueryDto,
  ): Promise<{ keys_deleted: number }> {
    return this.diagnose.resetLimits({
      type: query.actorType ?? 'user',
      id: query.actorId,
    });
  }
}
