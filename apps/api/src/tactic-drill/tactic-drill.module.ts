/**
 * KS-2230. Backend-модуль tactic-drill (drill-mode + stats + sprint-stubs).
 *
 * Зависит от глобального `PrismaModule` (registered в app) и `AuthModule`
 * (для guards `JwtAuthGuard` / `OptionalJwtGuard` через @nestjs/passport
 * AuthGuard('jwt') strategy registered AuthModule'ом).
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TacticDrillController } from './tactic-drill.controller';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillSprintService } from './tactic-drill-sprint.service';
import { TacticDrillSprintScheduler } from './tactic-drill-sprint.scheduler';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import { TacticDrillIncrementalScheduler } from './tactic-drill-incremental.scheduler';
import { TacticDrillRatingService } from './tactic-drill-rating.service';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';
import { DailyTacticDrillController } from './daily-tactic-drill.controller';
import { DailyTacticDrillService } from './daily-tactic-drill.service';
import { DailyTacticDrillImageService } from './daily-tactic-drill-image.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TacticDrillController, DailyTacticDrillController],
  providers: [
    TacticDrillService,
    TacticDrillSprintService,
    // KS-2380: каждую минуту финализирует sprint-сессии, по которым
    // фронт не успел вызвать `/sprint/finish` (закрытая вкладка,
    // потерянный фокус и т. д.). Без него score не попадает в БД,
    // лидерборд остаётся пустым.
    TacticDrillSprintScheduler,
    TacticDrillValidatorService,
    // KS-2245: cron-индексер новых партий из archive-БД. Включается
    // через ENV `TACTIC_DRILL_INCREMENTAL_ENABLED=1` (default off).
    TacticDrillIncrementalScheduler,
    // KS-2247: Stockfish-валидация drill'ов удалена в KS-2433
    // вместе с движком из api. Поля `sfRejected` / `sfValidatedAt`
    // в `tactic_drills` пока остаются как мёртвые — миграция на drop
    // оформлена отдельным коммитом.
    // KS-2311: drill rating (Glicko-1) + leaderboard.
    GlickoRatingService,
    TacticDrillRatingService,
    // KS-2250: daily drill для Telegram-рассылки.
    DailyTacticDrillService,
    DailyTacticDrillImageService,
  ],
  exports: [TacticDrillValidatorService],
})
export class TacticDrillModule implements OnModuleInit {
  constructor(
    private readonly drillService: TacticDrillService,
    private readonly ratingService: TacticDrillRatingService,
    private readonly sprintService: TacticDrillSprintService,
  ) {}

  /**
   * KS-2311: подключаем rating-сервис в drill-сервис через setter,
   * чтобы избежать circular DI (rating не зависит от drill, но drill
   * вызывает rating после `recordAttempt`). sprintService —
   * избежание unused-error для DI-хука.
   */
  onModuleInit(): void {
    this.drillService.setRatingService(this.ratingService);
    void this.sprintService;
  }
}
