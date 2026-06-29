/**
 * KS-4801 / ADR-152. `GET /admin/events` — read-доступ к
 * `events.actor_events` произвольного actor для diagnose без SSM/SQL.
 *
 * Защита — `AdminOrServiceGuard` (ADR-139 §3):
 *   - JWT-admin (`KS_ADMIN_USERS` whitelist) проходит без scope-чека;
 *   - service-account с токеном `ks_sa_*` обязан иметь scope
 *     `events:read` (см. `SCOPES.EVENTS_READ`).
 *
 * Поведение полностью симметрично `MeController.listEvents` (KS-4799),
 * различается только источник actor'а:
 *   - `/me/events` берёт actor из `req.user.id` (зашит на сервере);
 *   - `/admin/events` принимает `actorId` + опциональный `actorType`
 *     из query — service-account явно указывает кого смотрит.
 *
 * Бизнес-логика выборки переиспользуется из `AnalyticsDataService.listEvents`.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AdminOrServiceGuard } from '../auth/admin-or-service.guard';
import { RequiredScope } from '../auth/required-scope.decorator';
import { SCOPES } from '../auth/scopes';
import {
  AnalyticsDataService,
  decodeCursor,
  type ListEventsResult,
} from './analytics-data.service';
import { AdminListEventsQueryDto } from './dto/admin-list-events.dto';

@Controller('admin/events')
@UseGuards(AdminOrServiceGuard)
export class AdminEventsController {
  constructor(private readonly analyticsData: AnalyticsDataService) {}

  @Get()
  @RequiredScope(SCOPES.EVENTS_READ)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }))
  async listEvents(
    @Query() query: AdminListEventsQueryDto,
  ): Promise<ListEventsResult> {
    let cursor: ReturnType<typeof decodeCursor>;
    try {
      cursor = decodeCursor(query.cursor);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.analyticsData.listEvents(
      { type: query.actorType ?? 'user', id: query.actorId },
      {
        cursor: cursor ?? undefined,
        limit: query.limit ?? 50,
        types: query.types,
        showSystem: query.showSystem ?? false,
      },
    );
  }
}
