/**
 * KS-2230 (api-contract §5). 7 endpoints для tactic-drill.
 *
 * Auth-структура (api-contract §6):
 *  - `GET /types`       — optional auth (для unlocked-логики).
 *  - `GET /next`        — optional auth (гости получают drill без cooldown).
 *  - `POST /attempt`    — optional auth (гости получают результат без записи).
 *  - `GET /stats/me`    — required auth (без JWT — 401).
 *  - `POST /sprint/start`         — required auth (sprint без auth бессмыслен).
 *  - `POST /sprint/submit`        — required auth.
 *  - `GET /sprint/leaderboard`    — public.
 *
 * `/sprint/start` и `/sprint/submit` — заглушка (501 Not Implemented).
 * Полная реализация Redis-сессий sprint'а — KS-DRILL-SPRINT (E4).
 *
 * Защита эталона (api-contract §7): `getNext` возвращает `TacticDrillDto`
 * без `answer`. Эталон отдаётся только в response `recordAttempt` через
 * `correctAnswer`. E2E-тест проверяет, что `GET /next` не содержит
 * поля `answer` в JSON.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { TacticDrillService } from './tactic-drill.service';
import { GetNextQueryDto } from './dto/get-next-query.dto';
import { AttemptRequestDto } from './dto/attempt.dto';
import {
  SprintLeaderboardQueryDto,
  SprintStartDto,
} from './dto/sprint.dto';
import { normalizeAnswerData } from './dto/answer.dto';

function readUserId(req: Request): string | null {
  const r = req as AuthenticatedRequest;
  return r.user?.id ?? null;
}

@Controller('tactic-drill')
export class TacticDrillController {
  constructor(private readonly service: TacticDrillService) {}

  @Get('types')
  @UseGuards(OptionalJwtGuard)
  async listTypes(@Req() req: Request) {
    const userId = readUserId(req);
    return { types: await this.service.listTypes(userId) };
  }

  @Get('next')
  @UseGuards(OptionalJwtGuard)
  async getNext(@Req() req: Request, @Query() query: GetNextQueryDto) {
    const userId = readUserId(req);
    const drill = await this.service.getNext(
      userId,
      query.type,
      query.difficulty,
    );
    if (!drill) {
      throw new NotFoundException('no drills available');
    }
    return drill;
  }

  @Post('attempt')
  @UseGuards(OptionalJwtGuard)
  async attempt(@Req() req: Request, @Body() body: AttemptRequestDto) {
    if (body.mode !== 'drill' && body.mode !== 'lessons-embed') {
      throw new BadRequestException(
        'mode=sprint not supported on /attempt; use /sprint/submit',
      );
    }
    const norm = normalizeAnswerData(body.userAnswer);
    if (!norm.ok) throw new BadRequestException(norm.error);

    const userId = readUserId(req);
    return this.service.recordAttempt(
      userId,
      body.drillId,
      norm.value,
      body.timeMs,
    );
  }

  @Get('stats/me')
  @UseGuards(JwtAuthGuard)
  async statsMe(@Req() req: AuthenticatedRequest) {
    const userId = req.user?.id;
    if (!userId) throw new UnauthorizedException();
    return this.service.getMyStats(userId);
  }

  // ─── Sprint (заглушки, KS-DRILL-SPRINT E4) ─────────────────

  @Post('sprint/start')
  @UseGuards(JwtAuthGuard)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sprintStart(@Body() _body: SprintStartDto) {
    throw new HttpException(
      'sprint not implemented; tracked in KS-DRILL-SPRINT',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  @Post('sprint/submit')
  @UseGuards(JwtAuthGuard)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sprintSubmit(@Body() _body: AttemptRequestDto) {
    throw new HttpException(
      'sprint not implemented; tracked in KS-DRILL-SPRINT',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  @Get('sprint/leaderboard')
  async sprintLeaderboard(@Query() query: SprintLeaderboardQueryDto) {
    return this.service.getSprintLeaderboard(query.mode, query.limit);
  }
}
