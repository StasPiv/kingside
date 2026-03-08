import { Module } from '@nestjs/common';
<<<<<<< HEAD
import { DailyPuzzleController } from './daily-puzzle.controller';
import { DailyPuzzleService } from './daily-puzzle.service';
=======
>>>>>>> feature/KS-140
import { PuzzleController } from './puzzle.controller';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';

@Module({
<<<<<<< HEAD
  controllers: [DailyPuzzleController, PuzzleController],
  providers: [DailyPuzzleService, PuzzleService, PuzzleRatingService],
  exports: [DailyPuzzleService, PuzzleService, PuzzleRatingService],
=======
  controllers: [PuzzleController],
  providers: [PuzzleService, PuzzleRatingService],
  exports: [PuzzleService],
>>>>>>> feature/KS-140
})
export class PuzzleModule {}
