import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PuzzleRushService } from './puzzle-rush.service';
import { StartPuzzleRushDto, SubmitPuzzleAnswerDto } from './dto/puzzle-rush.dto';

@Controller('puzzles/rush')
@UseGuards(JwtAuthGuard)
export class PuzzleRushController {
  constructor(private readonly puzzleRushService: PuzzleRushService) {}

  @Post()
  start(@Request() req: any, @Body() dto: StartPuzzleRushDto) {
    return this.puzzleRushService.startSession(req.user.id, dto.timeLimitSec);
  }

  @Get('session')
  getSession(@Request() req: any) {
    return this.puzzleRushService.getSession(req.user.id);
  }

  @Get('next')
  getNextPuzzle(@Request() req: any) {
    return this.puzzleRushService.getNextPuzzle(req.user.id);
  }

  @Post('answer')
  answer(@Request() req: any, @Body() dto: SubmitPuzzleAnswerDto) {
    return this.puzzleRushService.submitAnswer(req.user.id, dto.uci);
  }

  @Delete('session')
  endSession(@Request() req: any) {
    return this.puzzleRushService.endSession(req.user.id);
  }

  @Get('leaderboard')
  getLeaderboard(
    @Query('timeLimitSec') timeLimitSec: string = '180',
    @Query('limit') limit: string = '20',
  ) {
    const timeMode = String(parseInt(timeLimitSec, 10) / 60);
    return this.puzzleRushService.getLeaderboard(timeMode, parseInt(limit, 10));
  }

  @Get('best')
  getUserBest(
    @Request() req: any,
    @Query('timeLimitSec') timeLimitSec: string = '180',
  ) {
    const timeMode = String(parseInt(timeLimitSec, 10) / 60);
    return this.puzzleRushService.getUserBest(req.user.id, timeMode);
  }
}
