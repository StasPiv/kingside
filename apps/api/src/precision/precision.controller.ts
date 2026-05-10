/**
 * KS-2718 / ADR-056 §5 B5–B6.
 *
 * Endpoints:
 *   - GET /precision/stats/me — Уровень А (top-блок).
 *   - GET /precision/attempts/:attemptId — Уровень Б (post-game review).
 *
 * Auth: оба эндпоинта требуют JwtAuthGuard.
 *   - stats/me — текущий user, всегда self.
 *   - attempts/:id — владелец или админ (`KS_ADMIN_USERS`).
 */
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserService } from '../auth/admin-user.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PrecisionService } from './precision.service';

@Controller('precision')
export class PrecisionController {
  constructor(
    private readonly precision: PrecisionService,
    private readonly adminCheck: AdminUserService,
  ) {}

  /**
   * KS-2718 B5. GET /precision/stats/me?since=ISO-date.
   * Только self — текущий пользователь из JWT.
   */
  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  async getStatsMe(
    @Request() req: AuthenticatedRequest,
    @Query('since') since?: string,
  ) {
    let sinceDate: Date | undefined;
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException(
          `Invalid 'since' query parameter: ${since}`,
        );
      }
      sinceDate = d;
    }
    return this.precision.getStatsForUser(req.user.id, sinceDate);
  }

  /**
   * KS-2718 B6. GET /precision/attempts/:attemptId.
   * 403 если запрос не свой attempt и не админ. 404 если attempt
   * не существует или не PVE.
   */
  @UseGuards(JwtAuthGuard)
  @Get('attempts/:attemptId')
  async getAttempt(
    @Request() req: AuthenticatedRequest,
    @Param('attemptId') attemptId: string,
  ) {
    const isAdmin = await this.adminCheck.isAdmin(req.user.id);
    return this.precision.getAttemptDetail(attemptId, req.user.id, isAdmin);
  }
}
