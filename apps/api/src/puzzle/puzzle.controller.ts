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
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { PuzzleService } from './puzzle.service';

@Controller('puzzles')
export class PuzzleController {
  constructor(private readonly puzzleService: PuzzleService) {}

  @UseGuards(JwtAuthGuard)
  @Get('random')
  getRandomPuzzle(@Request() req: any) {
    return this.puzzleService.getRandomPuzzle(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getPuzzleStats(@Request() req: any) {
    return this.puzzleService.getUserPuzzleStats(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('attempts')
  getAttempts(
    @Request() req: any,
    @Query('take', new DefaultValuePipe(20), ParseIntPipe) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    return this.puzzleService.getUserAttempts(req.user.id, take, skip);
  }

  @Get(':id')
  getPuzzle(@Param('id') id: string) {
    return this.puzzleService.getPuzzleById(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('attempt')
  submitAttempt(@Request() req: any, @Body() dto: SubmitAttemptDto) {
    return this.puzzleService.submitAttempt(req.user.id, dto.puzzleId, dto.solved);
  }
}
