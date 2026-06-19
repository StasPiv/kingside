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
import { AuthenticatedRequest } from '../common/authenticated-request';
import { TacticPuzzleService } from './tactic-puzzle.service';
import { SubmitTacticAttemptDto } from './dto/submit-tactic-attempt.dto';
import { BrowseTacticPuzzlesDto } from './dto/browse-tactic-puzzles.dto';

@Controller('tactic-puzzles')
export class TacticPuzzleController {
  constructor(private readonly service: TacticPuzzleService) {}

  /** GET /tactic-puzzles/next — следующий пазл для пользователя. */
  @UseGuards(JwtAuthGuard)
  @Get('next')
  async next(@Request() req: AuthenticatedRequest) {
    return this.service.getNextForUser(req.user.id);
  }

  /** GET /tactic-puzzles/browse — выборка с фильтрами и cursor-пагинацией. */
  @Get('browse')
  browse(@Query() query: BrowseTacticPuzzlesDto) {
    return this.service.browse(query);
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
