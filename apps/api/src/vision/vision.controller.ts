/**
 * KS-4982 / ADR-167 §5: REST-эндпоинты Vision-тренажёра.
 *
 *  - POST /vision/results — сохранение итога. `OptionalJwtGuard`: гость →
 *    no-op (`saved:false`), результат не сохраняется (ADR §5).
 *  - GET /vision/leaderboard?mode=&timeMode=&limit= — публичный, Redis-кэш.
 *  - GET /vision/stats/me, GET /vision/history — под `JwtAuthGuard`.
 *
 * Пер-вопросного эндпоинта нет: генерация и подсчёт на клиенте.
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { VisionService } from './vision.service';
import { SubmitVisionResultDto } from './dto/vision.dto';

type OptionalAuthRequest = AuthenticatedRequest & {
  user?: AuthenticatedRequest['user'] | null;
};

@Controller('vision')
export class VisionController {
  constructor(private readonly vision: VisionService) {}

  /** POST /vision/results — итог сессии. Гость → не сохраняется. */
  @UseGuards(OptionalJwtGuard)
  @Post('results')
  async saveResult(
    @Request() req: OptionalAuthRequest,
    @Body() body: SubmitVisionResultDto,
  ) {
    if (!req.user || !req.user.id) {
      return { saved: false, scoreId: null };
    }
    return this.vision.saveResult(req.user.id, body);
  }

  /** GET /vision/leaderboard?mode=&timeMode=&limit= — публичный, кэш Redis. */
  @Get('leaderboard')
  leaderboard(
    @Query('mode', new DefaultValuePipe('color')) mode: string,
    @Query('timeMode', new DefaultValuePipe('60s')) timeMode: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 20;
    return this.vision.leaderboard(mode, timeMode, Number.isNaN(n) ? 20 : n);
  }

  /** GET /vision/stats/me — личная статистика. */
  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  statsMe(@Request() req: AuthenticatedRequest) {
    return this.vision.statsForUser(req.user.id);
  }

  /** GET /vision/history?limit=&cursor= — пагинированная история. */
  @UseGuards(JwtAuthGuard)
  @Get('history')
  history(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20)) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.vision.historyForUser(req.user.id, Number(limit) || 20, cursor);
  }
}
