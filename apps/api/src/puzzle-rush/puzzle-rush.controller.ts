import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PuzzleRushService } from './puzzle-rush.service';
import { StartPuzzleRushDto, SubmitPuzzleAnswerDto } from './dto/puzzle-rush.dto';

@Controller('puzzle-rush')
export class PuzzleRushController {
  constructor(private readonly puzzleRushService: PuzzleRushService) {}

  @Post('start')
  @UseGuards(JwtAuthGuard)
  start(@Request() req: AuthenticatedRequest, @Body() dto: StartPuzzleRushDto) {
    return this.puzzleRushService.startSession(req.user.id, dto.timeMode);
  }

  @Get('session')
  @UseGuards(JwtAuthGuard)
  getSession(@Request() req: AuthenticatedRequest) {
    return this.puzzleRushService.getSession(req.user.id);
  }

  @Post('solve')
  @UseGuards(JwtAuthGuard)
  solve(@Request() req: AuthenticatedRequest, @Body() dto: SubmitPuzzleAnswerDto) {
    return this.puzzleRushService.submitAnswer(req.user.id, dto.uci);
  }

  @Delete('session')
  @UseGuards(JwtAuthGuard)
  endSession(@Request() req: AuthenticatedRequest) {
    return this.puzzleRushService.endSession(req.user.id);
  }

  @Get('leaderboard')
  getLeaderboard(
    @Query('timeMode') timeMode: string = '3',
    @Query('limit') limit: string = '20',
  ) {
    return this.puzzleRushService.getLeaderboard(timeMode, parseInt(limit, 10));
  }

  @Get('best')
  @UseGuards(JwtAuthGuard)
  getUserBest(
    @Request() req: AuthenticatedRequest,
    @Query('timeMode') timeMode: string = '3',
  ) {
    return this.puzzleRushService.getUserBest(req.user.id, timeMode);
  }

  @Get('review/:scoreId')
  @UseGuards(JwtAuthGuard)
  getSessionReview(@Request() req: AuthenticatedRequest, @Param('scoreId') scoreId: string) {
    return this.puzzleRushService.getSessionReview(scoreId, req.user.id);
  }

  @Get('review/:scoreId/puzzle/:puzzleId/best-move')
  @UseGuards(JwtAuthGuard)
  getSessionPuzzleBestMove(
    @Request() req: AuthenticatedRequest,
    @Param('scoreId') scoreId: string,
    @Param('puzzleId') puzzleId: string,
  ) {
    return this.puzzleRushService.getSessionPuzzleBestMove(scoreId, puzzleId, req.user.id);
  }
}
