/**
 * KS-3409 / ADR-086 §9 B2. REST-endpoints guess-the-move.
 * Все требуют JwtAuthGuard (persist привязан к пользователю; гость 401).
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { GuessService } from './guess.service';
import { StartGuessSessionDto, SubmitGuessMoveDto } from './dto/guess.dto';

@Controller('guess')
@UseGuards(JwtAuthGuard)
export class GuessController {
  constructor(private readonly guess: GuessService) {}

  /** POST /guess/sessions — старт сессии. */
  @Post('sessions')
  start(
    @Request() req: AuthenticatedRequest,
    @Body() dto: StartGuessSessionDto,
  ) {
    return this.guess.startSession(req.user.id, dto);
  }

  /** POST /guess/sessions/:id/move — ход пользователя (server-trust). */
  @Post('sessions/:id/move')
  move(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SubmitGuessMoveDto,
  ) {
    return this.guess.submitMove(req.user.id, id, dto);
  }

  /** POST /guess/sessions/:id/finish — финал (две точности + звёзды). */
  @Post('sessions/:id/finish')
  finish(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.guess.finish(req.user.id, id);
  }

  /** GET /guess/sessions/:id — review (сессия + ходы). */
  @Get('sessions/:id')
  review(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.guess.getSession(req.user.id, id);
  }

  /** GET /guess/history?limit=&offset= — список сессий пользователя. */
  @Get('history')
  history(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.guess.history(req.user.id, limit, offset);
  }
}
