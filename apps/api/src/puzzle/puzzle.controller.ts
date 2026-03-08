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
import { PuzzleService } from './puzzle.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { FindPuzzlesDto } from './dto/find-puzzles.dto';

@Controller('puzzles')
export class PuzzleController {
  constructor(private readonly puzzleService: PuzzleService) {}

  /**
   * GET /puzzles — search puzzles by theme and difficulty.
   * Query: ?themes[]=fork&themes[]=pin&ratingMin=1200&ratingMax=1600&limit=10
   */
  @Get()
  findPuzzles(@Query() dto: FindPuzzlesDto) {
    return this.puzzleService.findPuzzles({
      themes: dto.themes,
      ratingMin: dto.ratingMin,
      ratingMax: dto.ratingMax,
      limit: dto.limit,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('next')
  getNextPuzzle(@Request() req: any) {
    return this.puzzleService.getNextPuzzle(req.user.id);
  }

  /**
   * GET /puzzles/next/:theme — get next puzzle by theme for the user.
   */
  @UseGuards(JwtAuthGuard)
  @Get('next/:theme')
  getNextPuzzleByTheme(@Request() req: any, @Param('theme') theme: string) {
    return this.puzzleService.getNextPuzzleByTheme(req.user.id, theme);
  }

  @Get(':id')
  getPuzzle(@Param('id', ParseUUIDPipe) id: string) {
    return this.puzzleService.getPuzzle(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/attempt')
  submitAttempt(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.puzzleService.submitAttempt(
      req.user.id,
      id,
      dto.solved,
      dto.timeMs,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  getMyStats(@Request() req: any) {
    return this.puzzleService.getStats(req.user.id);
  }
}
