import { Module } from '@nestjs/common';
import { DailyPuzzleController } from './daily-puzzle.controller';
import { DailyPuzzleService } from './daily-puzzle.service';

@Module({
  controllers: [DailyPuzzleController],
  providers: [DailyPuzzleService],
  exports: [DailyPuzzleService],
})
export class PuzzleModule {}
