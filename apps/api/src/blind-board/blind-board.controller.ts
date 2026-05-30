/**
 * KS-3441 / ADR-088 §11 B2. REST-endpoints blind-board.
 * Все требуют JwtAuthGuard: M1-решение «гость без persist» = 401.
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
import { BlindBoardService } from './blind-board.service';
import {
  StartBlindBoardSessionBodyDto,
  SubmitBlindBoardAnswerBodyDto,
} from './dto/blind-board.dto';

@Controller('blind-board')
export class BlindBoardController {
  constructor(private readonly blind: BlindBoardService) {}

  /**
   * POST /blind-board/sessions — старт новой сессии.
   * KS-3484/3486: тело может содержать опц. `config` (прогрессивная
   * сложность). Если опущен — backend применяет DEFAULT_BLIND_BOARD_CONFIG.
   */
  @UseGuards(JwtAuthGuard)
  @Post('sessions')
  start(
    @Request() req: AuthenticatedRequest,
    @Body() body: StartBlindBoardSessionBodyDto,
  ) {
    return this.blind.createSession(req.user.id, body.config);
  }

  /** POST /blind-board/sessions/:id/answer — ответ игрока. */
  @UseGuards(JwtAuthGuard)
  @Post('sessions/:id/answer')
  answer(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SubmitBlindBoardAnswerBodyDto,
  ) {
    return this.blind.submitAnswer(req.user.id, id, {
      square: body.square as never,
      pieceType: body.pieceType,
    });
  }

  /** GET /blind-board/leaderboard?limit=20 — топ best-streak. Публичный. */
  @Get('leaderboard')
  leaderboard(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.blind.leaderboard(limit);
  }
}
