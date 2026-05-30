import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { OpeningTrainerService } from './opening-trainer.service';
import { ArchivePositionProxyService } from './archive-position-proxy.service';
import {
  CreateRepertoireDto,
  CreateRepertoireFromAnalysisDto,
  CreateRepertoireSourceDto,
  ListRepertoiresQueryDto,
  MoveDto,
  StartSessionDto,
  UpdateRepertoireDto,
  UpdateRepertoireSourceDto,
} from './dto/repertoire.dto';
import { ArchivePositionGamesQueryDto } from './dto/archive-position.dto';

/**
 * KS-3272 / ADR-077 §3. 12 endpoints Opening Trainer'а.
 *
 * Все endpoints под `JwtAuthGuard`. Owner-check встроен в сервис
 * (404 NotFound вместо 403 — не светим существование чужих ресурсов).
 *
 * `OPENING_REPERTOIRE_LIMITS.maxRepertoiresPerUser` (50) и
 * `maxActiveSessionsPerUser` (10) валидируются в сервисе → 409 Conflict.
 *
 * Парсер PGN бросает `BadRequestException` на синтаксис / лимиты ADR §3.2.
 */
@Controller('opening-trainer')
@UseGuards(JwtAuthGuard)
export class OpeningTrainerController {
  constructor(
    private readonly service: OpeningTrainerService,
    private readonly archivePositionProxy: ArchivePositionProxyService,
  ) {}

  /**
   * KS-3469 / ADR-090 §4.2 B2. GET-proxy к archive-service
   * `/api/archive/games/by-position` с встроенными defaults для
   * сценария «репертуар из мастер-партий 2400+ по позиции»:
   *   minElo=2400, sort=topElo, bucket=master,
   *   timeControlCategory=classical.
   * Любой default переопределяется query-параметром.
   */
  @Get('archive-position/games')
  async archivePositionGames(
    @Query() query: ArchivePositionGamesQueryDto,
  ) {
    return this.archivePositionProxy.findGamesByPosition({
      fen: query.fen,
      cursor: query.cursor,
      limit: query.limit,
      bucket: query.bucket,
      sort: query.sort,
      minElo: query.minElo,
      timeControlCategory: query.timeControlCategory,
      color: query.color,
      result: query.result,
      since: query.since,
      move: query.move,
      player: query.player,
      eco: query.eco,
    });
  }

  // ── Repertoire CRUD (5 endpoints) ──────────────────────────────

  @Post('repertoires')
  async createRepertoire(
    @Req() req: Request,
    @Body() body: CreateRepertoireDto,
  ) {
    return this.service.createRepertoire(requireUserId(req), body);
  }

  // ── KS-3293 (M2 B7): POST /repertoires/from-analysis ───────────

  @Post('repertoires/from-analysis')
  async createFromAnalysis(
    @Req() req: Request,
    @Body() body: CreateRepertoireFromAnalysisDto,
  ) {
    return this.service.createRepertoireFromAnalysis(requireUserId(req), body);
  }

  @Get('repertoires')
  async listRepertoires(
    @Req() req: Request,
    @Query() query: ListRepertoiresQueryDto,
  ) {
    const includeStats = (query.include ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes('stats');
    return this.service.listRepertoires(requireUserId(req), includeStats);
  }

  @Get('repertoires/:id')
  async getRepertoire(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.getRepertoire(requireUserId(req), id);
  }

  @Patch('repertoires/:id')
  async updateRepertoire(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRepertoireDto,
  ) {
    return this.service.updateRepertoire(requireUserId(req), id, body);
  }

  @Delete('repertoires/:id')
  async deleteRepertoire(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.deleteRepertoire(requireUserId(req), id);
  }

  // ── KS-3326 / ADR-078: source endpoints ────────────────────────

  @Get('repertoires/:id/sources')
  async listSources(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.listRepertoireSources(requireUserId(req), id);
  }

  @Get('repertoires/:id/sources/:sourceId')
  async getSource(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.service.getRepertoireSource(requireUserId(req), id, sourceId);
  }

  @Post('repertoires/:id/sources')
  async addSource(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateRepertoireSourceDto,
  ) {
    return this.service.addRepertoireSource(requireUserId(req), id, {
      pgn: body.pgn,
      name: body.name ?? null,
      sourceKind: body.sourceKind,
      sourceAnalysisId: body.sourceAnalysisId ?? null,
    });
  }

  @Patch('repertoires/:id/sources/:sourceId')
  async updateSource(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body() body: UpdateRepertoireSourceDto,
  ) {
    return this.service.updateRepertoireSource(
      requireUserId(req),
      id,
      sourceId,
      { pgn: body.pgn, name: body.name },
    );
  }

  @Delete('repertoires/:id/sources/:sourceId')
  async deleteSource(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ) {
    return this.service.deleteRepertoireSource(
      requireUserId(req),
      id,
      sourceId,
    );
  }

  // ── Session lifecycle (7 endpoints) ────────────────────────────

  @Post('repertoires/:id/sessions')
  async startSession(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) repertoireId: string,
    @Body() body: StartSessionDto,
  ) {
    return this.service.startSession(requireUserId(req), repertoireId, body);
  }

  @Get('sessions/:sid')
  async getSession(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
  ) {
    return this.service.getSession(requireUserId(req), sid);
  }

  @Post('sessions/:sid/move')
  async move(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
    @Body() body: MoveDto,
  ) {
    return this.service.makeMove(requireUserId(req), sid, body);
  }

  @Post('sessions/:sid/hint')
  async hint(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
  ) {
    return this.service.hint(requireUserId(req), sid);
  }

  @Post('sessions/:sid/giveup')
  async giveup(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
  ) {
    return this.service.giveup(requireUserId(req), sid);
  }

  @Post('sessions/:sid/undo')
  async undo(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
  ) {
    return this.service.undo(requireUserId(req), sid);
  }

  @Post('sessions/:sid/finish')
  async finish(
    @Req() req: Request,
    @Param('sid', new ParseUUIDPipe()) sid: string,
  ) {
    return this.service.finish(requireUserId(req), sid);
  }

  // ── KS-3290 (M2 B4): GET /reviews/due ──────────────────────────

  @Get('reviews/due')
  async dueReviews(
    @Req() req: Request,
    @Query('repertoireId') repertoireId?: string,
  ) {
    return this.service.listDueReviews(requireUserId(req), { repertoireId });
  }

  // ── KS-3292 (M2 B6): GET /repertoires/:id/progress ─────────────

  @Get('repertoires/:id/progress')
  async repertoireProgress(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.listRepertoireProgress(requireUserId(req), id);
  }

  // ── KS-3294 (M2 B8): GET /repertoires/:id/active-session ───────

  @Get('repertoires/:id/active-session')
  async activeSession(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.getActiveSession(requireUserId(req), id);
  }

  // ── KS-3283 (M2 stats): GET /repertoires/:id/stats ─────────────

  @Get('repertoires/:id/stats')
  async repertoireStats(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.getRepertoireStats(requireUserId(req), id);
  }
}

function requireUserId(req: Request): string {
  const r = req as AuthenticatedRequest;
  const id = r.user?.id;
  if (!id) {
    throw new Error('No user on request — JwtAuthGuard should have rejected');
  }
  return id;
}
