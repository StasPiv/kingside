import { Module } from '@nestjs/common';
import { PuzzleController } from './puzzle.controller';
import { PuzzleService } from './puzzle.service';

@Module({
  controllers: [PuzzleController],
  providers: [PuzzleService],
  exports: [PuzzleService],
})
export class PuzzleModule {}
