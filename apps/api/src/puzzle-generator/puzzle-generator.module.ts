import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StockfishService } from '../engine/stockfish.service';
import { GlickoRatingService } from './glicko-rating.service';
import { PuzzleGeneratorController } from './puzzle-generator.controller';
import { PuzzleGeneratorService } from './puzzle-generator.service';

@Module({
  imports: [AuthModule],
  controllers: [PuzzleGeneratorController],
  providers: [PuzzleGeneratorService, StockfishService, GlickoRatingService],
  exports: [PuzzleGeneratorService, GlickoRatingService],
})
export class PuzzleGeneratorModule {}
