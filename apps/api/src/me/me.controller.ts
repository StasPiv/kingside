/**
 * KS-4697 / ADR-147 §6.2 + §6.3. GDPR-эндпоинты для авторизованного
 * пользователя (`actor_type='user'`).
 *
 *   - `PATCH /me/consent { analytics: boolean }` — Art. 7(3) отзыв/выдача
 *     согласия. Только меняет `User.analyticsConsent`, накопленные
 *     данные не трогает. Сбрасывает локальный консент-кэш в `EventsService`.
 *   - `DELETE /me/analytics-data` — Art. 17 право на удаление. Удаляет
 *     `actor_events` + Redis-агрегаты. Идемпотентно.
 *   - `GET /me/analytics-export` — Art. 20 портативность. Streaming
 *     JSON, rate-limit 1/24ч через Redis-flag (см. consumeOnce).
 *
 * Защита — `JwtAuthGuard` (см. AuthModule), `req.user.id` — UUID
 * пользователя.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  AnalyticsDataService,
  decodeCursor,
  type ListEventsResult,
} from '../events/analytics-data.service';
import { EventsService } from '../events/events.service';
import { ListEventsQueryDto } from './dto/list-events.dto';

export class UpdateConsentDto {
  @IsBoolean()
  analytics!: boolean;
}

/**
 * Rate-limit для экспорта: 1 запрос в 24 часа на actor. Реализован
 * через Redis-флаг с TTL — без отдельной таблицы.
 */
const EXPORT_THROTTLE_SEC = 24 * 60 * 60;

@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  private readonly logger = new Logger(MeController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly analyticsData: AnalyticsDataService,
    private readonly events: EventsService,
  ) {}

  @Patch('consent')
  async updateConsent(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateConsentDto,
  ): Promise<{ analytics: boolean }> {
    const userId = req.user.id;
    await this.prisma.user.update({
      where: { id: userId },
      data: { analyticsConsent: body.analytics },
    });
    // Сбросить кэш consent у EventsService — следующий track сразу
    // подхватит новое значение, без 60-секундного лага.
    this.events.invalidateConsentCache(userId);
    return { analytics: body.analytics };
  }

  @Delete('analytics-data')
  @HttpCode(HttpStatus.OK)
  async deleteAnalytics(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ eventsDeleted: number; aggKeysDeleted: number; hintsKeysDeleted: number }> {
    const userId = req.user.id;
    const res = await this.analyticsData.deleteActorData({
      type: 'user',
      id: userId,
    });
    this.events.invalidateConsentCache(userId);
    this.logger.log(
      `/me/analytics-data DELETE user=${userId} eventsDeleted=${res.eventsDeleted} aggKeysDeleted=${res.aggKeysDeleted} hintsKeysDeleted=${res.hintsKeysDeleted}`,
    );
    return res;
  }

  /**
   * KS-4799 / ADR-152 §2.1. `GET /me/events` — страница «Мои действия».
   *
   * Фильтр `actorId = req.user.id AND actorType = 'user'` зашит на
   * сервере; параметра `actorId` в DTO нет, клиент не может попросить
   * чужие события. По смыслу симметрично `streamExport` /
   * `deleteActorData` — единая модель доступа в `MeController`.
   *
   * Парсинг `cursor` — здесь, до сервиса. Service принимает уже
   * типизированный `ListEventsCursor`, чтобы не подмешивать base64-
   * декодирование к доменной логике.
   */
  @Get('events')
  // KS-4799: @Transform / @Type в DTO работают только если pipe в
  // режиме transform — глобально у нас `whitelist: true` без transform
  // (см. main.ts:86). Локальный override.
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }))
  async listEvents(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListEventsQueryDto,
  ): Promise<ListEventsResult> {
    let cursor: ReturnType<typeof decodeCursor>;
    try {
      cursor = decodeCursor(query.cursor);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.analyticsData.listEvents(
      { type: 'user', id: req.user.id },
      {
        cursor: cursor ?? undefined,
        limit: query.limit ?? 50,
        types: query.types,
        showSystem: query.showSystem ?? false,
      },
    );
  }

  @Get('analytics-export')
  async exportAnalytics(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user.id;
    const allowed = await consumeOnce(this.redis, `gdpr:export:user:${userId}`);
    if (!allowed) {
      throw new ForbiddenException(
        'analytics-export rate-limit: 1 request per 24h',
      );
    }
    await streamExportResponse(
      this.analyticsData,
      { type: 'user', id: userId },
      res,
    );
  }
}

/**
 * Атомарная проверка «выдать токен на одну операцию в окне». Возвращает
 * true ровно один раз за окно `EXPORT_THROTTLE_SEC`. Реализована через
 * `SET key 1 NX EX <sec>` — стандартный Redis-паттерн.
 */
export async function consumeOnce(
  redis: RedisService,
  key: string,
  ttlSec: number = EXPORT_THROTTLE_SEC,
): Promise<boolean> {
  try {
    const r = await redis.set(key, '1', 'EX', ttlSec, 'NX');
    return r === 'OK';
  } catch {
    // Redis недоступен → fail-closed, чтобы не открыть rate-limit обход.
    return false;
  }
}

/**
 * Streaming-helper для GDPR-export: настраивает заголовки + перебирает
 * async-generator. Общий для /me и /guest.
 */
export async function streamExportResponse(
  analyticsData: AnalyticsDataService,
  actor: import('../events/events.types').Actor,
  res: Response,
): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="analytics-export-${actor.type}-${actor.id}.json"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  const now = new Date().toISOString();
  for await (const chunk of analyticsData.streamExport(actor, now)) {
    res.write(chunk);
  }
  res.end();
}
