import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  CreateLectureDto,
  MyLecturesQueryDto,
  PublicLecturesQueryDto,
  ScheduleQueryDto,
  StartLectureDto,
  UpdateLectureDto,
} from './dto/create-lecture.dto';
import { LecturesService } from './lectures.service';
import { LecturesAccessService } from './lectures-access.service';
import { toPublicDto } from '../common/public-dto.mapper';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';

/**
 * KS-3784 / ADR-113 §4 эпик 1: REST-эндпоинты лекций.
 *
 *   POST   /lectures                              — создать (Jwt-only).
 *   PATCH  /lectures/:id                          — KS-3800: правки scheduled-лекции (Jwt-only, owner).
 *   POST   /lectures/:id/start                    — перевести в live (Jwt-only, owner).
 *   POST   /lectures/:id/cancel                   — KS-3800: отменить scheduled-лекцию (Jwt-only, owner).
 *   GET    /lectures/:id                          — детали (публично, public + unlisted).
 *   GET    /lectures/:id/recording                — запись (KS-3793, immutable cache).
 *   GET    /coaches/:username/lectures            — список тренера (публично, public-only).
 */
@Controller()
export class LecturesController {
  constructor(
    private readonly service: LecturesService,
    private readonly access: LecturesAccessService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('lectures')
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateLectureDto,
  ) {
    return this.service.create(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('lectures/:id')
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLectureDto,
  ) {
    return this.service.update(id, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/start')
  @HttpCode(200)
  async start(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartLectureDto,
  ) {
    return this.service.start(id, req.user.id, { analysisId: dto.analysisId });
  }

  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(id, req.user.id);
  }

  /**
   * KS-3864. Удалить лекцию (owner-only). Разрешено в scheduled /
   * cancelled / recorded; для live — 409.
   */
  @UseGuards(JwtAuthGuard)
  @Delete('lectures/:id')
  @HttpCode(204)
  async remove(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.delete(id, req.user.id);
  }

  /**
   * KS-3864. Принудительно завершить live-лекцию: status → recorded,
   * endedAt → NOW, durationMs пересчитан; LiveAnalysis закрывается;
   * audio финализируется best-effort. Для не-live статусов — 409.
   */
  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/force-end')
  @HttpCode(200)
  async forceEnd(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.forceEnd(id, req.user.id);
  }

  /**
   * KS-4188 / ADR-128 §7.6.1.6. Публичный агрегат опубликованных
   * лекций (`visibility='public'`, `status≠cancelled`) для SEO-индексации
   * `/lectures`. Без class-guard'а (ADR-128 §6.8.2): `OptionalJwtGuard`
   * +  `RedisRateLimitGuard` 60/min на сам метод.
   *
   * `toPublicDto` вырезает приватные поля тренера (email/phone/lastSeenAt)
   * из вложенных объектов согласно §6.8.3.
   *
   * Внимание: маршрут объявлен ПЕРЕД `lectures/:id` — Nest резолвит роуты
   * в порядке регистрации, иначе `/lectures/public` уходит в getById
   * (`ParseUUIDPipe` → 400 "uuid is expected").
   */
  @UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
  @RateLimit(60, 60)
  @Get('lectures/public')
  async listPublic(
    @Request() req: AuthenticatedRequest,
    @Query() query: PublicLecturesQueryDto,
  ) {
    const result = await this.service.listPublic({
      limit: query.limit,
      offset: query.offset,
    });
    return toPublicDto(result, req.user ?? null);
  }

  /**
   * KS-3932 / ADR-118 §2.4.1. Опциональный JWT + резолвер доступа.
   * Поведение:
   *   - `public` / `unlisted` → отдаём как и раньше;
   *   - `restricted` без JWT → 401 `{ error: 'auth_required' }`;
   *   - `restricted` без grant'а → 403 `{ error: 'lecture_access_revoked' }`;
   *   - owner всегда видит свою лекцию (даже restricted).
   */
  @UseGuards(OptionalJwtGuard)
  @Get('lectures/:id')
  async getById(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.access.assertAccess(id, req.user?.id ?? null);
    const result = await this.service.getById(id);
    // KS-4134: гость не должен видеть email/phone/lastSeenAt автора и
    // приглашённых участников. Маппер режет nested-приватные поля.
    return toPublicDto(result, req.user ?? null);
  }

  /**
   * KS-3793 / ADR-113 §4 крупная задача 2. Запись лекции.
   * Cache-Control immutable безопасен: запись по id не перезаписывается,
   * `LectureRecording.id` — UUID, агрессивное кеширование CDN/браузера
   * не приведёт к рассинхронизации.
   *
   * KS-3932 / ADR-118 §2.4.1: тот же контракт 401/403, что и getById.
   * Доступ проверяется ДО возврата записи; при denied никаких заголовков
   * Cache-Control в ответе нет (Nest сериализует HttpException без них),
   * так что 401/403 не попадает в CDN-кеш.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('lectures/:id/recording')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  async getRecording(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.access.assertAccess(id, req.user?.id ?? null);
    const result = await this.service.getRecordingByLectureId(id);
    // KS-4134: даже у записи в метаданных может быть автор —
    // выкидываем приватные поля для гостя.
    return toPublicDto(result, req.user ?? null);
  }

  /**
   * KS-4133 / ADR-128 §6.8.3. OptionalJwtGuard + toPublicDto: для гостя
   * вырезаются `email`, `phone`, `lastSeenAt` и прочие приватные поля
   * тренера / приглашённых, если они вдруг попадут в DTO лекции.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('coaches/:username/lectures')
  async listByCoach(
    @Request() req: AuthenticatedRequest,
    @Param('username') username: string,
    @Query('status')
    status?: 'scheduled' | 'live' | 'recorded' | 'cancelled',
  ) {
    const result = await this.service.listByCoach(username, status);
    return toPublicDto(result, req.user ?? null);
  }

  /**
   * KS-3937 / ADR-118 §2.4.1. Личный кабинет учеников: лекции, к
   * которым у текущего пользователя есть доступ — собственные +
   * allowlist'ом. JWT обязателен (для анонимов список бессмысленен).
   *
   * Query: `status?`, `limit?` (1..100, default 50), `offset?`
   * (>=0, default 0). Сортировка `updatedAt DESC`. Ответ —
   * `{ items, total, hasMore }`.
   */
  @UseGuards(JwtAuthGuard)
  @Get('my/lectures')
  async listMyLectures(
    @Request() req: AuthenticatedRequest,
    @Query() query: MyLecturesQueryDto,
  ) {
    return this.service.listMyLectures(req.user.id, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /**
   * KS-3801 / ADR-113 §4 крупная задача 3. Публичное расписание
   * тренера: предстоящие и идущие сейчас лекции с visibility=public
   * в окне `from`–`to` (обе границы опциональные).
   *
   * KS-4133: OptionalJwtGuard + toPublicDto — гость не видит приватных
   * полей тренера в каждой записи расписания.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('coaches/:username/schedule')
  async scheduleByCoach(
    @Request() req: AuthenticatedRequest,
    @Param('username') username: string,
    @Query() query: ScheduleQueryDto,
  ) {
    const result = await this.service.scheduleByCoach(
      username,
      query.from,
      query.to,
    );
    return toPublicDto(result, req.user ?? null);
  }
}
