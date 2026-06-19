/**
 * KS-4340 / ADR-135. NestJS-модуль обёртки tactic-puzzle-generator.
 * Зависит от StockfishModule (Stockfish-pool, режим go nodes) и
 * PrismaModule (writer основной БД, запись в `tactic_puzzles`).
 *
 * MaiaAnnotationService инстанцируется внутри `TacticPuzzleGeneratorService.run()`
 * через `fromEnv(stockfish)` — singleton за CLI-процесс, делит ONNX-сессию
 * с continuous annotation (см. `maia-policy-provider.ts`).
 */
import { Module } from '@nestjs/common';
import { StockfishModule } from '../stockfish/stockfish.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TacticPuzzleGeneratorService } from './tactic-puzzle-generator.service';

@Module({
  imports: [StockfishModule, PrismaModule],
  providers: [TacticPuzzleGeneratorService],
  exports: [TacticPuzzleGeneratorService],
})
export class TacticPuzzleGeneratorModule {}
