import {
  Body,
  Controller,
<<<<<<< HEAD
  Get,
  Param,
  ParseUUIDPipe,
  Post,
=======
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
>>>>>>> feature/KS-140
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
<<<<<<< HEAD
import { PuzzleService } from './puzzle.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
=======
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { PuzzleService } from './puzzle.service';
>>>>>>> feature/KS-140

@Controller('puzzles')
export class PuzzleController {
  constructor(private readonly puzzleService: PuzzleService) {}

  @UseGuards(JwtAuthGuard)
<<<<<<< HEAD
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
=======
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
>>>>>>> feature/KS-140
  }
}
