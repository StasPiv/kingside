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
// KS-2642 / ADR-054 Phase C — единый guard доступа.
import { LessonsAccessGuard } from './lessons-access.guard';
// KS-2643 / ADR-054 Phase C2 — унифицированные роуты `/lessons/*`.
// Делегируют на User*Service из `UserCoursesModule`, который мы
// импортируем ниже для DI экспортируемых сервисов.
import { UserCoursesModule } from './user-courses/user-courses.module';
import {
  Adr054UnifiedCoursesController,
  Adr054UnifiedLessonsController,
  Adr054UnifiedLessonStepsController,
  Adr054UnifiedProgressController,
} from './adr054-unified.controller';
import { Adr054UnifiedCoursesPublicController } from './adr054-unified-public.controller';

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
  // KS-2643: UserCoursesModule даёт `UserCoursesService` etc. для
  // делегации в унифицированных роутах + расширённого
  // `CoursesController.list/getBySlug`.
  imports: [
    PrismaModule,
    RedisModule,
    PuzzleModule,
    AuthModule,
    UserCoursesModule,
  ],
  controllers: [
    // KS-2646: публичный controller `/lessons/courses/authors` — ПЕРЕД
    // `CoursesController`, чтобы `/authors` не упирался в `:slug` (под
    // auth). Без `JwtAuthGuard` — лобби-витрина авторов доступна
    // анонимам.
    Adr054UnifiedCoursesPublicController,
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
    // KS-2643 unified controllers.
    Adr054UnifiedCoursesController,
    Adr054UnifiedLessonsController,
    Adr054UnifiedLessonStepsController,
    Adr054UnifiedProgressController,
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
    // KS-2642 / ADR-054 Phase C. Регистрируем guard в provider'ах,
    // чтобы Nest резолвил его DI (Reflector + PrismaService) при
    // навешивании `@UseGuards(LessonsAccessGuard)` на унифицированных
    // роутах, которые добавляются в следующих подзадачах Phase C.
    LessonsAccessGuard,
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
    LessonsAccessGuard,
  ],
})
export class LessonsModule {}
