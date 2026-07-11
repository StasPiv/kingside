import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { StudyScheduleService } from './study-schedule.service';
import { NotificationChannelService } from './notification-channel.service';
import { UpdateStudyScheduleDto } from './dto/update-study-schedule.dto';
import { CreateNotificationChannelDto } from './dto/create-notification-channel.dto';
import type {
  CreateNotificationChannelResponse,
  NotificationChannelsResponse,
  StudyScheduleResponse,
} from '@kingside/shared';

/**
 * REST занятий (KS-4880 / ADR-160, задача 1 из 6).
 *
 * Пути:
 *   GET    /api/study/schedule      — расписание (null до создания)
 *   PUT    /api/study/schedule      — создать/обновить расписание
 *   GET    /api/study/channels      — каналы уведомлений
 *   POST   /api/study/channels      — подключить канал (telegram → deep-link)
 *   DELETE /api/study/channels/:id  — отключить канал
 *
 * Все эндпоинты требуют JWT.
 */
@Controller('study')
@UseGuards(JwtAuthGuard)
export class StudyController {
  constructor(
    private readonly schedules: StudyScheduleService,
    private readonly channels: NotificationChannelService,
  ) {}

  @Get('schedule')
  async getSchedule(@Request() req: AuthenticatedRequest): Promise<StudyScheduleResponse> {
    const schedule = await this.schedules.get(req.user.id);
    return { schedule };
  }

  @Put('schedule')
  @HttpCode(HttpStatus.OK)
  async putSchedule(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateStudyScheduleDto,
  ): Promise<StudyScheduleResponse> {
    const schedule = await this.schedules.upsert(req.user.id, dto);
    return { schedule };
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
