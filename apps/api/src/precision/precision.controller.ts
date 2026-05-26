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
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AdminUserService } from '../auth/admin-user.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PrecisionService } from './precision.service';
import { NotFoundException } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';

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
    const sinceDate = parseIsoOrThrow(since, 'since');
    return this.precision.getStatsForUser(req.user.id, sinceDate);
  }

  /**
   * KS-2727 B7.1. GET /precision/trends/me?bucket=&since=&until= —
   * тренд точности и удержания по бакетам времени.
   */
  @UseGuards(JwtAuthGuard)
  @Get('trends/me')
  async getTrends(
    @Request() req: AuthenticatedRequest,
    @Query('bucket') bucket?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    const allowed = ['day', 'week', 'month'] as const;
    const safeBucket: 'day' | 'week' | 'month' =
      bucket && (allowed as readonly string[]).includes(bucket)
        ? (bucket as 'day' | 'week' | 'month')
        : 'week';
    const sinceDate = parseIsoOrThrow(since, 'since');
    const untilDate = parseIsoOrThrow(until, 'until');
    return this.precision.getTrendsForUser(req.user.id, {
      bucket: safeBucket,
      since: sinceDate,
      until: untilDate,
    });
  }

  /**
   * KS-2727 B7.2. GET /precision/breakdowns/me?since= — разбивка по
   * фазе игры и темам пазла (top-10 по «слабости»).
   */
  @UseGuards(JwtAuthGuard)
  @Get('breakdowns/me')
  async getBreakdowns(
    @Request() req: AuthenticatedRequest,
    @Query('since') since?: string,
  ) {
    const sinceDate = parseIsoOrThrow(since, 'since');
    return this.precision.getBreakdownsForUser(req.user.id, sinceDate);
  }

  /**
   * KS-3345 / ADR-079 §3.3 / §4.2. GET /precision/scope-counts —
   * счётчики для chips-bar pill'ов. JwtAuthGuard: гостю не отдаём
   * (у него нет drafts/published). Cache 60s в Redis per-user.
   */
  @UseGuards(JwtAuthGuard)
  @Get('scope-counts')
  async getScopeCounts(@Request() req: AuthenticatedRequest) {
    return this.precision.getScopeCounts(req.user.id);
  }

  /**
   * KS-3346 / ADR-079 §3.5 / §4.4. GET /precision/me/rating —
   * precision-рейтинг текущего user'а. Гостю 401. Для нового
   * пользователя возвращаем default (1500/350/0/null).
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/rating')
  async getMyRating(@Request() req: AuthenticatedRequest) {
    return this.precision.getMyRating(req.user.id);
  }

  /**
   * KS-3358 / ADR-080 §4.3. GET /precision/theme-counts — counter
   * per-theme для bottom-sheet'а фильтра. OptionalJwtGuard (гость →
   * scope=server, без hideSolved). Cache 60s.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('theme-counts')
  async getThemeCounts(
    @Request() req: ExpressRequest & { user?: { id: string } },
    @Query('scope') scopeParam?: string,
    @Query('objective') objectiveParam?: string,
    @Query('hideSolved') hideSolvedParam?: string,
    @Query('ratingMin') ratingMinParam?: string,
    @Query('ratingMax') ratingMaxParam?: string,
  ) {
    const ALLOWED_SCOPES = new Set(['server', 'drafts', 'published']);
    const scope =
      scopeParam && ALLOWED_SCOPES.has(scopeParam)
        ? (scopeParam as 'server' | 'drafts' | 'published')
        : 'server';
    const ALLOWED_OBJ = new Set(['all', 'convertAdvantage', 'saveEquality']);
    const objective =
      objectiveParam && ALLOWED_OBJ.has(objectiveParam)
        ? (objectiveParam as 'all' | 'convertAdvantage' | 'saveEquality')
        : undefined;
    const ratingMin = ratingMinParam ? parseFloat(ratingMinParam) : undefined;
    const ratingMax = ratingMaxParam ? parseFloat(ratingMaxParam) : undefined;
    if (
      (ratingMin !== undefined && !Number.isFinite(ratingMin)) ||
      (ratingMax !== undefined && !Number.isFinite(ratingMax))
    ) {
      throw new BadRequestException('ratingMin/Max must be numbers');
    }
    return this.precision.getThemeCounts(req.user?.id ?? null, {
      scope,
      objective,
      hideSolved: hideSolvedParam !== 'false',
      ratingMin,
      ratingMax,
    });
  }

  /**
   * KS-3344 / ADR-079 §3.4 / §4.1. GET /precision/next — авто-подбор
   * следующей задачи. OptionalJwtGuard: гостю target=1200,
   * только scope=server. Query: scope, objective?, overrideRatingMin?,
   * overrideRatingMax?, hideSolved? (default true).
   * 200: { puzzleId, rating, ratingDelta }.
   * 404: { puzzleId: null, reason: 'no_puzzles_available' }.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('next')
  async pickNext(
    @Request() req: ExpressRequest & { user?: { id: string } },
    @Query('scope') scopeParam?: string,
    @Query('objective') objectiveParam?: string,
    @Query('overrideRatingMin') overrideRatingMinParam?: string,
    @Query('overrideRatingMax') overrideRatingMaxParam?: string,
    @Query('hideSolved') hideSolvedParam?: string,
  ) {
    const ALLOWED_SCOPES = new Set(['server', 'drafts', 'published']);
    const scope: 'server' | 'drafts' | 'published' =
      scopeParam && ALLOWED_SCOPES.has(scopeParam)
        ? (scopeParam as 'server' | 'drafts' | 'published')
        : 'server';
    const ALLOWED_OBJ = new Set(['all', 'convertAdvantage', 'saveEquality']);
    const objective =
      objectiveParam && ALLOWED_OBJ.has(objectiveParam)
        ? (objectiveParam as 'all' | 'convertAdvantage' | 'saveEquality')
        : undefined;
    const userId = req.user?.id ?? null;

    const overrideMin = overrideRatingMinParam
      ? parseFloat(overrideRatingMinParam)
      : undefined;
    const overrideMax = overrideRatingMaxParam
      ? parseFloat(overrideRatingMaxParam)
      : undefined;
    if (
      (overrideMin !== undefined && !Number.isFinite(overrideMin)) ||
      (overrideMax !== undefined && !Number.isFinite(overrideMax))
    ) {
      throw new BadRequestException(
        'overrideRatingMin/Max must be numbers',
      );
    }

    const hideSolved = hideSolvedParam !== 'false'; // default true

    const picked = await this.precision.pickNext(userId, {
      scope,
      objective,
      overrideRatingMin: overrideMin,
      overrideRatingMax: overrideMax,
      hideSolved,
    });
    if (!picked) {
      throw new NotFoundException({
        puzzleId: null,
        reason: 'no_puzzles_available',
      });
    }
    return picked;
  }

  /**
   * KS-2724. GET /precision/attempts/me?limit=&offset= — список
   * PVE-попыток текущего пользователя (последние первыми) с
   * агрегатами Уровня А для рендера «истории попыток» на /precision.
   *
   * Только self. limit ≤ 100 (защита от DoS); offset ≥ 0.
   */
  @UseGuards(JwtAuthGuard)
  @Get('attempts/me')
  async listMyAttempts(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);
    return this.precision.listAttemptsForUser(
      req.user.id,
      safeLimit,
      safeOffset,
    );
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

/**
 * KS-2727: парсинг опц. ISO-date query параметра. `undefined` → undefined,
 * непарсимая строка → 400.
 */
function parseIsoOrThrow(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid '${name}' query parameter: ${raw}`);
  }
  return d;
}
