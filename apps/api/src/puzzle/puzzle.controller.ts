import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PuzzleService } from './puzzle.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';

@Controller('puzzles')
export class PuzzleController {
  constructor(private readonly puzzleService: PuzzleService) {}

  @UseGuards(JwtAuthGuard)
  @Get('next')
  getNextPuzzle(@Request() req: any) {
    return this.puzzleService.getNextPuzzle(req.user.id);
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
