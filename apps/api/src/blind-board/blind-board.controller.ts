/**
 * KS-3441 / ADR-088 §11 B2. REST-endpoints blind-board.
 *
 * KS-4138 / ADR-128 §4 (PF). Тренажёр стал «гость без persist»:
 *  - POST /sessions, POST /sessions/:id/answer → `OptionalJwtGuard`,
 *    для гостя → 204 no-op (ADR-128 §11.13).
 *  - GET /sessions/:id (review) → `OptionalJwtGuard`, гость → 404
 *    (личная сессия, не светим существование).
 *  - GET /leaderboard — публичный, как и был.
 *  - Личные read /stats/me, /trends/me, /breakdowns/me, /history —
 *    остаются под `JwtAuthGuard`.
 *  - DELETE /sessions/:id — `JwtAuthGuard`.
 *
 * Public-эндпоинты под `RedisRateLimitGuard` 60/min по IP
 * (ADR-128 §6.8.4).
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { BlindBoardService } from './blind-board.service';
import {
  StartBlindBoardSessionBodyDto,
  SubmitBlindBoardAnswerBodyDto,
} from './dto/blind-board.dto';

type OptionalAuthRequest = AuthenticatedRequest & {
  user?: AuthenticatedRequest['user'] | null;
};

function isGuest(req: OptionalAuthRequest): boolean {
  return !req.user || !req.user.id;
}

@Controller('blind-board')
export class BlindBoardController {
  constructor(private readonly blind: BlindBoardService) {}

  /**
   * POST /blind-board/sessions — старт новой сессии.
   * KS-3484/3486: тело может содержать опц. `config` (прогрессивная
   * сложность). Если опущен — backend применяет DEFAULT_BLIND_BOARD_CONFIG.
   *
   * KS-4138: гость → 204 без записи в БД.
   */
  @UseGuards(OptionalJwtGuard)
  @Post('sessions')
  @HttpCode(200)
  async start(
    @Request() req: OptionalAuthRequest,
    @Body() body: StartBlindBoardSessionBodyDto,
  ) {
    if (isGuest(req)) return undefined;
    return this.blind.createSession(req.user!.id, body.config);
  }

  /** POST /blind-board/sessions/:id/answer — ответ игрока. */
  @UseGuards(OptionalJwtGuard)
  @Post('sessions/:id/answer')
  async answer(
    @Request() req: OptionalAuthRequest,
    @Param('id') id: string,
    @Body() body: SubmitBlindBoardAnswerBodyDto,
  ) {
    if (isGuest(req)) return undefined;
    return this.blind.submitAnswer(req.user!.id, id, {
      square: body.square as never,
      pieceType: body.pieceType,
    });
  }

  /** GET /blind-board/leaderboard?limit=20 — топ best-streak. Публичный. */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(60, 60)
  @Get('leaderboard')
  leaderboard(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.blind.leaderboard(limit);
  }

  /** KS-3509. GET /blind-board/stats/me — личная статистика. */
  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  statsMe(@Request() req: AuthenticatedRequest) {
    return this.blind.statsForUser(req.user.id);
  }

  /** KS-3509. GET /blind-board/trends/me?bucket=day|week|month (default week). */
  @UseGuards(JwtAuthGuard)
  @Get('trends/me')
  trendsMe(
    @Request() req: AuthenticatedRequest,
    @Query('bucket') bucket?: string,
  ) {
    return this.blind.trendsForUser(req.user.id, bucket);
  }

  /** KS-3509. GET /blind-board/breakdowns/me — ошибки по типу фигуры. */
  @UseGuards(JwtAuthGuard)
  @Get('breakdowns/me')
  breakdownsMe(@Request() req: AuthenticatedRequest) {
    return this.blind.breakdownsForUser(req.user.id);
  }

  /** KS-3509. GET /blind-board/history?cursor=&limit= — пагинированная история. */
  @UseGuards(JwtAuthGuard)
  @Get('history')
  history(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.blind.historyForUser(req.user.id, limit, cursor);
  }

  /**
   * KS-3517. GET /blind-board/sessions/:id — review одной сессии:
   * session + config + per-round attempts. Для finished — раскрывается
   * startPosition. Owner-check.
   *
   * KS-4138: OptionalJwtGuard; гость → 404 (личная сессия, не светим).
   *
   * NB: путь ОБЯЗАТЕЛЬНО ПОСЛЕ литеральных префиксов (`stats/me`,
   * `trends/me`, `breakdowns/me`, `leaderboard`, `history`), иначе Nest
   * сматчит их с `:id`.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('sessions/:id')
  review(@Request() req: OptionalAuthRequest, @Param('id') id: string) {
    if (isGuest(req)) {
      throw new NotFoundException('blind-board session not found');
    }
    return this.blind.reviewSession(req.user!.id, id);
  }

  /**
   * KS-3530. DELETE /blind-board/sessions/:id — удалить blind-board
   * сессию (cascade BlindBoardAttempt). После — пересчёт
   * `User.blindBoardBestStreak` из оставшихся finished-сессий. 204
   * No Content при успехе. Owner-check.
   */
  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  @HttpCode(204)
  async deleteSession(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.blind.deleteSession(req.user.id, id);
  }
}
