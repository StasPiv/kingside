import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { PuzzleModule } from '../puzzle/puzzle.module';
import { AuthModule } from '../auth/auth.module';
import { CoursesController } from './courses.controller';
import { LessonsController } from './lessons.controller';
import { ProgressController } from './progress.controller';
import { PuzzleResolverController } from './puzzle-resolver.controller';
import { LessonsI18nController } from './i18n.controller';
import { LessonReviewsController } from './reviews.controller';
import { ActiveCoursesController } from './active-courses.controller';
import { LessonsAdminController } from './admin/lessons-admin.controller';
import { LessonsAdminLessonsController } from './admin/lessons-admin-lessons.controller';
import { LessonsAdminStepsController } from './admin/lessons-admin-steps.controller';
import { LessonsAdminImportController } from './admin/lessons-admin-import.controller';
import { CoursesService } from './courses.service';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import { Sm2Service } from './sm2.service';
import { Sm2SchedulerService } from './sm2.scheduler';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import { ActiveCoursesService } from './active-courses.service';
import { LessonsAdminService } from './admin/lessons-admin.service';
import { LessonsAdminImportService } from './admin/lessons-admin-import.service';

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
  // KS-1962: AuthModule импортируем ради DI-резолва AdminEmailGuard
  // в LessonsAdminController (JwtAuthGuard ходит через passport
  // и DI не требует, но AdminEmailGuard — Injectable с PrismaService).
  imports: [PrismaModule, RedisModule, PuzzleModule, AuthModule],
  controllers: [
    CoursesController,
    LessonsController,
    ProgressController,
    PuzzleResolverController,
    LessonsI18nController,
    LessonReviewsController,
    ActiveCoursesController,
    LessonsAdminController,
    LessonsAdminLessonsController,
    LessonsAdminStepsController,
    LessonsAdminImportController,
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
    LessonsAdminService,
    LessonsAdminImportService,
  ],
  exports: [
    CoursesService,
    LessonsService,
    ProgressService,
    LessonPuzzleResolverService,
    Sm2Service,
    AdaptiveDifficultyService,
    ActiveCoursesService,
    LessonsAdminService,
    LessonsAdminImportService,
  ],
})
export class LessonsModule {}
