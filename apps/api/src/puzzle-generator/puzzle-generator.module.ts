import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StockfishService } from '../engine/stockfish.service';
import { PuzzleGeneratorController } from './puzzle-generator.controller';
import { PuzzleGeneratorService } from './puzzle-generator.service';

@Module({
  imports: [AuthModule],
  controllers: [PuzzleGeneratorController],
  providers: [PuzzleGeneratorService, StockfishService],
  exports: [PuzzleGeneratorService],
})
export class PuzzleGeneratorModule {}
