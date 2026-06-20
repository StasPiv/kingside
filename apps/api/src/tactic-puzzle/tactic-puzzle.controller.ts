/**
 * KS-4342 / ADR-135 §2.4. Маршруты раздела «Точность» — `/tactic-puzzles/*`.
 * Авторизация — `JwtAuthGuard` на персональных эндпоинтах (`/next`,
 * `/attempts`, `/mistakes`); `/:id` и `/browse` публичны как у /puzzles.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { TacticPuzzleService } from './tactic-puzzle.service';
import { SubmitTacticAttemptDto } from './dto/submit-tactic-attempt.dto';
import { BrowseTacticPuzzlesDto } from './dto/browse-tactic-puzzles.dto';
import { ListTacticAttemptsDto } from './dto/list-tactic-attempts.dto';
import { RatingHistoryDto } from './dto/rating-history.dto';

@Controller('tactic-puzzles')
export class TacticPuzzleController {
  constructor(private readonly service: TacticPuzzleService) {}

  /** GET /tactic-puzzles/next — следующий пазл для пользователя. */
  @UseGuards(JwtAuthGuard)
  @Get('next')
  async next(@Request() req: AuthenticatedRequest) {
    return this.service.getNextForUser(req.user.id);
  }

  /** GET /tactic-puzzles/browse — выборка с фильтрами и cursor-пагинацией.
   *  KS-4365: добавлен фильтр `?solved=true|false` по факту успешной
   *  попытки текущего пользователя. Гостям маршрут остаётся доступным
   *  через OptionalJwtGuard (req.user может быть null); фильтр solved
   *  тогда игнорируется. */
  @UseGuards(OptionalJwtGuard)
  @Get('browse')
  browse(
    @Request() req: AuthenticatedRequest,
    @Query() query: BrowseTacticPuzzlesDto,
  ) {
    const userId = req.user?.id ?? null;
    return this.service.browse(query, userId);
  }

  /** GET /tactic-puzzles/mistakes — журнал ошибок текущего пользователя. */
  @UseGuards(JwtAuthGuard)
  @Get('mistakes')
  mistakes(
    @Request() req: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return this.service.listMistakes(req.user.id, cursor, limit);
  }

  /**
   * KS-4356. POST /tactic-puzzles/mistakes/:puzzleId/resolve — ручной
   * резолв ошибки в журнале (пользователь сам отметил «понял, дальше»).
   * 404 если непрорешённой записи нет.
   */
  @UseGuards(JwtAuthGuard)
  @Post('mistakes/:puzzleId/resolve')
  async resolveMistake(
    @Request() req: AuthenticatedRequest,
    @Param('puzzleId', new ParseUUIDPipe()) puzzleId: string,
  ): Promise<{ resolved: true }> {
    await this.service.resolveMistake(req.user.id, puzzleId);
    return { resolved: true };
  }

  /** KS-4356. GET /tactic-puzzles/attempts — история попыток. */
  @UseGuards(JwtAuthGuard)
  @Get('attempts')
  listAttempts(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListTacticAttemptsDto,
  ) {
    return this.service.listAttempts(req.user.id, query);
  }

  /** KS-4356. GET /tactic-puzzles/attempts/:id — детали попытки. */
  @UseGuards(JwtAuthGuard)
  @Get('attempts/:id')
  getAttemptDetail(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.getAttemptDetail(req.user.id, id);
  }

  /** KS-4356. GET /tactic-puzzles/stats/me — агрегаты текущего пользователя. */
  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  getStats(@Request() req: AuthenticatedRequest) {
    return this.service.getUserStats(req.user.id);
  }

  /** KS-4356. GET /tactic-puzzles/stats/rating-history — точки графика. */
  @UseGuards(JwtAuthGuard)
  @Get('stats/rating-history')
  getRatingHistory(
    @Request() req: AuthenticatedRequest,
    @Query() query: RatingHistoryDto,
  ) {
    return this.service.getRatingHistory(req.user.id, query);
  }

  /** GET /tactic-puzzles/:id — один пазл по id. */
  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getById(id);
  }

  /** POST /tactic-puzzles/:id/attempts — приём попытки. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/attempts')
  submitAttempt(
    @Request() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SubmitTacticAttemptDto,
  ) {
    return this.service.submitAttempt(req.user.id, id, body);
  }
}
