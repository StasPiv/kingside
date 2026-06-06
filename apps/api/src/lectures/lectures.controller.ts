import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { CreateLectureDto, StartLectureDto } from './dto/create-lecture.dto';
import { LecturesService } from './lectures.service';

/**
 * KS-3784 / ADR-113 §4 эпик 1: REST-эндпоинты лекций.
 *
 *   POST   /lectures                              — создать (Jwt-only).
 *   POST   /lectures/:id/start                    — перевести в live (Jwt-only, owner).
 *   GET    /lectures/:id                          — детали (публично, public + unlisted).
 *   GET    /lectures/:id/recording                — запись (KS-3793, immutable cache).
 *   GET    /coaches/:username/lectures            — список тренера (публично, public-only).
 */
@Controller()
export class LecturesController {
  constructor(private readonly service: LecturesService) {}

  @UseGuards(JwtAuthGuard)
  @Post('lectures')
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateLectureDto,
  ) {
    return this.service.create(req.user.id, dto);
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

  @Get('lectures/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id);
  }

  /**
   * KS-3793 / ADR-113 §4 крупная задача 2. Запись лекции.
   * Cache-Control immutable безопасен: запись по id не перезаписывается,
   * `LectureRecording.id` — UUID, агрессивное кеширование CDN/браузера
   * не приведёт к рассинхронизации.
   */
  @Get('lectures/:id/recording')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  getRecording(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getRecordingByLectureId(id);
  }

  @Get('coaches/:username/lectures')
  listByCoach(
    @Param('username') username: string,
    @Query('status')
    status?: 'scheduled' | 'live' | 'recorded' | 'cancelled',
  ) {
    return this.service.listByCoach(username, status);
  }
}
