import {
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { MistakesService } from './mistakes.service';

/**
 * REST-эндпоинты дневника ошибок (L-31, KS-1802; relocated KS-1927 /
 * ADR-032 §4).
 *
 * URL-префикс — `/puzzle/mistakes/*`, рядом с существующим
 * `@Controller('puzzle')`. Дневник ошибок концептуально про задачи
 * (Lichess puzzles + game mistakes), а не про учебные «уроки», поэтому
 * namespace `puzzle/` точнее. Старый префикс `/lessons/mistakes/*`
 * больше не зарегистрирован — Nest роутер вернёт 404; редирект для
 * legacy-клиентов делает фронт (KS-1928), не бэкенд.
 *
 * Глобальный префикс `/api` выставляется в `main.ts`, поэтому
 * публичные пути:
 *   `/api/puzzle/mistakes/aggregates`,
 *   `/api/puzzle/mistakes/recommendations`.
 */
@UseGuards(JwtAuthGuard)
@Controller('puzzle/mistakes')
export class MistakesController {
  constructor(private readonly service: MistakesService) {}

  /**
   * GET /api/puzzle/mistakes/aggregates?since=ISO&limit=N
   *
   * Темы, по которым пользователь чаще всего ошибался. `since` — опциональный
   * cutoff (ISO-8601). `limit` — верхняя граница размера списка (default/max
   * см. `MistakesService`).
   */
  @Get('aggregates')
  async getAggregates(
    @Request() req: AuthenticatedRequest,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    const sinceDate = parseSince(since);
    const limitNum = parseLimit(limit);
    return this.service.getAggregates(req.user.id, {
      since: sinceDate,
      limit: limitNum,
    });
  }

  /**
   * GET /api/puzzle/mistakes/recommendations
   *
   * Топ-3 тем за последние 30 дней → готовые `PuzzleStep`-payload'ы.
   */
  @Get('recommendations')
  async getRecommendations(@Request() req: AuthenticatedRequest) {
    return this.service.getRecommendations(req.user.id);
  }
}

function parseSince(since: string | undefined): Date | undefined {
  if (!since) return undefined;
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`Invalid "since": expected ISO-8601, got "${since}"`);
  }
  return d;
}

function parseLimit(limit: string | undefined): number | undefined {
  if (!limit) return undefined;
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException(`Invalid "limit": expected positive integer, got "${limit}"`);
  }
  return n;
}
