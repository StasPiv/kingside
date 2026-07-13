import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { StudyScheduleService } from './study-schedule.service';
import { NotificationChannelService } from './notification-channel.service';
import { StudySessionService } from './study-session.service';
import { StudyDiagnosticsService } from './study-diagnostics.service';
import { UpsertStudyScheduleDto } from './dto/upsert-study-schedule.dto';
import { CreateNotificationChannelDto } from './dto/create-notification-channel.dto';
import type {
  CreateNotificationChannelResponse,
  NotificationChannelsResponse,
  StudyHistoryResponse,
  StudyScheduleResponse,
  StudySchedulesResponse,
  StudySessionsCurrentResponse,
} from '@kingside/shared';

/**
 * REST занятий (KS-4880, KS-4886 / ADR-160; KS-4927 / ADR-163 §5 —
 * несколько тренировок, синглтон-эндпоинты заменены).
 *
 * Пути:
 *   GET    /api/study/schedules        — все тренировки пользователя
 *   POST   /api/study/schedules        — создать тренировку (лимит 5)
 *   PUT    /api/study/schedules/:id    — обновить (слоты replace-on-write)
 *   DELETE /api/study/schedules/:id    — удалить (каскад слотов и сессий)
 *   GET    /api/study/sessions/current — ближайшее занятие каждой тренировки
 *   GET    /api/study/channels         — каналы уведомлений
 *   POST   /api/study/channels         — подключить канал (telegram → deep-link)
 *   DELETE /api/study/channels/:id     — отключить канал
 *
 * Все эндпоинты требуют JWT.
 */
@Controller('study')
@UseGuards(JwtAuthGuard)
export class StudyController {
  constructor(
    private readonly schedules: StudyScheduleService,
    private readonly channels: NotificationChannelService,
    private readonly sessions: StudySessionService,
    private readonly diagnostics: StudyDiagnosticsService,
  ) {}

  /**
   * KS-4886 → KS-4927 / ADR-163 §5: ближайшее занятие каждой активной
   * тренировки для страницы /study.
   */
  @Get('sessions/current')
  async getCurrentSessions(
    @Request() req: AuthenticatedRequest,
  ): Promise<StudySessionsCurrentResponse> {
    const sessions = await this.sessions.getCurrent(req.user.id);
    return { sessions };
  }

  /**
   * KS-4916: история занятий со score и сводкой домашки (блок
   * «история» на /study). limit 1..50, default 10.
   */
  @Get('history')
  async getHistory(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<StudyHistoryResponse> {
    const items = await this.sessions.getHistory(
      req.user.id,
      Math.min(50, Math.max(1, limit)),
    );
    return { items };
  }

  /**
   * KS-4896: диагностика СВОИХ занятий — сырые строки расписания,
   * последних сессий (задачи + журнал доставки с ошибками) и каналов.
   * Прод-БД недоступна извне; этот endpoint отвечает на «есть ли у
   * меня занятие и что с доставкой» без доступа к БД.
   */
  @Get('diagnostics')
  async getDiagnostics(@Request() req: AuthenticatedRequest) {
    return this.diagnostics.collect(req.user.id);
  }

  /** KS-4927 / ADR-163 §5: все тренировки пользователя. */
  @Get('schedules')
  async getSchedules(
    @Request() req: AuthenticatedRequest,
  ): Promise<StudySchedulesResponse> {
    const schedules = await this.schedules.list(req.user.id);
    return { schedules };
  }

  /** KS-4927: создать тренировку (лимит 5; пересечение слотов → 400). */
  @Post('schedules')
  async createSchedule(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpsertStudyScheduleDto,
  ): Promise<StudyScheduleResponse> {
    const schedule = await this.schedules.create(req.user.id, dto);
    return { schedule };
  }

  /** KS-4927: обновить тренировку — слоты replace-on-write. */
  @Put('schedules/:id')
  @HttpCode(HttpStatus.OK)
  async putSchedule(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertStudyScheduleDto,
  ): Promise<StudyScheduleResponse> {
    const schedule = await this.schedules.update(req.user.id, id, dto);
    return { schedule };
  }

  /** KS-4927: удалить тренировку (каскад слотов и сессий, вкл. историю). */
  @Delete('schedules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSchedule(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.schedules.delete(req.user.id, id);
  }

  @Get('channels')
  async getChannels(
    @Request() req: AuthenticatedRequest,
  ): Promise<NotificationChannelsResponse> {
    const channels = await this.channels.list(req.user.id);
    return { channels };
  }

  @Post('channels')
  async createChannel(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateNotificationChannelDto,
  ): Promise<CreateNotificationChannelResponse> {
    return this.channels.create(req.user.id, dto.type);
  }

  @Delete('channels/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteChannel(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.channels.delete(req.user.id, id);
  }
}
