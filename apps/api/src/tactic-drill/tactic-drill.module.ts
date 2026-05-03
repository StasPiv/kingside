/**
 * KS-2230. Backend-модуль tactic-drill (drill-mode + stats + sprint-stubs).
 *
 * Зависит от глобального `PrismaModule` (registered в app) и `AuthModule`
 * (для guards `JwtAuthGuard` / `OptionalJwtGuard` через @nestjs/passport
 * AuthGuard('jwt') strategy registered AuthModule'ом).
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TacticDrillController } from './tactic-drill.controller';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillSprintService } from './tactic-drill-sprint.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import { TacticDrillIncrementalScheduler } from './tactic-drill-incremental.scheduler';
import { TacticDrillSfValidatorService } from './tactic-drill-sf-validator.service';
import { TacticDrillSfValidatorScheduler } from './tactic-drill-sf-validator.scheduler';
import { StockfishService } from '../engine/stockfish.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TacticDrillController],
  providers: [
    TacticDrillService,
    TacticDrillSprintService,
    TacticDrillValidatorService,
    // KS-2245: cron-индексер новых партий из archive-БД. Включается
    // через ENV `TACTIC_DRILL_INCREMENTAL_ENABLED=1` (default off).
    TacticDrillIncrementalScheduler,
    // KS-2247: Stockfish-валидация drill'ов с риском неоднозначности
    // (find-mate-in-one-square / find-hanging-piece). 1 поз/сек.
    // Включается через ENV `TACTIC_DRILL_SF_VALIDATOR_ENABLED=1`.
    StockfishService,
    TacticDrillSfValidatorService,
    TacticDrillSfValidatorScheduler,
  ],
  exports: [TacticDrillValidatorService],
})
export class TacticDrillModule {}
