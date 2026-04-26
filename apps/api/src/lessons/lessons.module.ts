import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { PuzzleModule } from '../puzzle/puzzle.module';
import { CoursesController } from './courses.controller';
import { LessonsController } from './lessons.controller';
import { ProgressController } from './progress.controller';
import { PuzzleResolverController } from './puzzle-resolver.controller';
import { LessonsI18nController } from './i18n.controller';
import { LessonReviewsController } from './reviews.controller';
import { ActiveCoursesController } from './active-courses.controller';
import { CoursesService } from './courses.service';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import { Sm2Service } from './sm2.service';
import { Sm2SchedulerService } from './sm2.scheduler';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import { ActiveCoursesService } from './active-courses.service';

/**
 * LessonsModule — тонкий слой над существующими доменами (ADR-024 §2.5,
 * ADR-025 §2.6).
 *
 *  - `PuzzleModule` — `PuzzleStep` в уроках обращается к задачам через
 *    `PuzzleService` / `PuzzleRatingService`.
 *  - `RedisModule` — для distributed-lock'а cron'а SM-2 (ADR-025 §2.6).
 *  - `AnalysisModule`, `WorkshopModule`, `EngineModule` подключим по мере
 *    появления соответствующих типов шагов (`game_review` — итерация 3).
 *
 * `@nestjs/schedule` подключается в `app.module.ts` (`ScheduleModule.forRoot()`).
 */
@Module({
  imports: [PrismaModule, RedisModule, PuzzleModule],
  controllers: [
    CoursesController,
    LessonsController,
    ProgressController,
    PuzzleResolverController,
    LessonsI18nController,
    LessonReviewsController,
    ActiveCoursesController,
  ],
  providers: [
    CoursesService,
    LessonsService,
    ProgressService,
    LessonPuzzleResolverService,
    Sm2Service,
    Sm2SchedulerService,
    AdaptiveDifficultyService,
    ActiveCoursesService,
  ],
  exports: [
    CoursesService,
    LessonsService,
    ProgressService,
    LessonPuzzleResolverService,
    Sm2Service,
    AdaptiveDifficultyService,
    ActiveCoursesService,
  ],
})
export class LessonsModule {}
