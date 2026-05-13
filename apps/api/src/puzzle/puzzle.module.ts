import { Module } from '@nestjs/common';
import { DailyPuzzleController } from './daily-puzzle.controller';
import { DailyPuzzleService } from './daily-puzzle.service';
import { PuzzleController } from './puzzle.controller';
import { PuzzleService } from './puzzle.service';
import { PuzzleRatingService } from './puzzle-rating.service';
import { GlickoRatingService } from './glicko-rating.service';
// KS-1927: MistakesModule переехал из `lessons/` в `puzzle/` (ADR-032 §4).
import { MistakesModule } from './mistakes.module';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2952 (ADR-061 §8): MCP-секция `puzzles` — задачи (lichess data),
// попытки, рейтинг, daily-puzzle.
@McpDiscoveryModule({
  section: 'puzzles',
  title: 'Шахматные задачи',
  description:
    'Шахматные задачи (puzzles) — подбор по рейтингу/теме, ' +
    'регистрация попыток, daily-puzzle. Сюда — если пользователь хочет ' +
    'решать задачи, увидеть свой рейтинг по задачам или дневник ошибок.',
  defaultAuth: 'optional',
})
@Module({
  imports: [MistakesModule],
  controllers: [DailyPuzzleController, PuzzleController],
  providers: [DailyPuzzleService, PuzzleService, PuzzleRatingService, GlickoRatingService],
  exports: [DailyPuzzleService, PuzzleService, PuzzleRatingService],
})
export class PuzzleModule {}
