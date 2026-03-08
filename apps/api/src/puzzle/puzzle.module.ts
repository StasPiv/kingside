import { Module } from '@nestjs/common';
import { PuzzleController } from './puzzle.controller';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';

@Module({
  controllers: [PuzzleController],
  providers: [PuzzleService, PuzzleRatingService],
  exports: [PuzzleService],
})
export class PuzzleModule {}
