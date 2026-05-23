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
import {
  CreateRepertoireDto,
  ListRepertoiresQueryDto,
  MoveDto,
  StartSessionDto,
  UpdateRepertoireDto,
} from './dto/repertoire.dto';

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
  constructor(private readonly service: OpeningTrainerService) {}

  // ── Repertoire CRUD (5 endpoints) ──────────────────────────────

  @Post('repertoires')
  async createRepertoire(
    @Req() req: Request,
    @Body() body: CreateRepertoireDto,
  ) {
    return this.service.createRepertoire(requireUserId(req), body);
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
}

function requireUserId(req: Request): string {
  const r = req as AuthenticatedRequest;
  const id = r.user?.id;
  if (!id) {
    throw new Error('No user on request — JwtAuthGuard should have rejected');
  }
  return id;
}
