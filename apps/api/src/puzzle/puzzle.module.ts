import { Module } from '@nestjs/common';
import { DailyPuzzleController } from './daily-puzzle.controller';
import { DailyPuzzleService } from './daily-puzzle.service';
import { PuzzleController } from './puzzle.controller';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';
import { GlickoRatingService } from './glicko-rating.service';

@Module({
  controllers: [DailyPuzzleController, PuzzleController],
  providers: [DailyPuzzleService, PuzzleService, PuzzleRatingService, GlickoRatingService],
  exports: [DailyPuzzleService, PuzzleService, PuzzleRatingService],
})
export class PuzzleModule {}
