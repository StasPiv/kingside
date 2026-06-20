/**
 * KS-4342 / ADR-135 §2.4. NestJS-модуль раздела «Точность».
 * Изолирован от legacy `PuzzleModule` (см. ADR-135 §2.6 / T9 — чистка
 * legacy `/puzzles` ветвей идёт отдельно после переезда фронта).
 *
 * `GlickoRatingService` — stateless и провайдится здесь же напрямую,
 * чтобы не цеплять `PuzzleModule` целиком ради одного хелпера.
 */
import { Module } from '@nestjs/common';
import { TacticPuzzleController } from './tactic-puzzle.controller';
import { TacticPuzzleService } from './tactic-puzzle.service';
import { TacticRatingSnapshotScheduler } from './tactic-rating-snapshot.scheduler';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';
// KS-4357 / ADR-136 §3.6. RedisModule нужен distributed-lock'у
// планировщика дневного снимка рейтинга (по образцу Sm2SchedulerService).
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  controllers: [TacticPuzzleController],
  providers: [
    TacticPuzzleService,
    GlickoRatingService,
    TacticRatingSnapshotScheduler,
  ],
  exports: [TacticPuzzleService],
})
export class TacticPuzzleModule {}
