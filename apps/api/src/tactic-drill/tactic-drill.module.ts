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
  ],
  exports: [TacticDrillValidatorService],
})
export class TacticDrillModule {}
