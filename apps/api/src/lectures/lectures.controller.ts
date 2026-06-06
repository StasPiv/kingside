import {
  Body,
  Controller,
  Get,
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

  @Get('coaches/:username/lectures')
  listByCoach(
    @Param('username') username: string,
    @Query('status')
    status?: 'scheduled' | 'live' | 'recorded' | 'cancelled',
  ) {
    return this.service.listByCoach(username, status);
  }
}
