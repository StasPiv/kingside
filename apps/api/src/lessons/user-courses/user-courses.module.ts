import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserCoursesService } from './user-courses.service';
import { UserLessonsService } from './user-lessons.service';
import { UserLessonStepsService } from './user-lesson-steps.service';
import { UserProgressService } from './user-progress.service';
import { UserCourseOwnerGuard } from './user-course-owner.guard';
import { SlugService } from './slug.service';

/**
 * UserCoursesModule — пользовательские курсы (ADR-026, KS-1829).
 *
 * KS-2647 / ADR-054 Phase E1. Legacy-контроллеры
 * (`UserCoursesController`, `UserCoursesPublicController`,
 * `UserLessonsController`, `UserLessonStepsController`,
 * `UserProgressController`) и alias-контроллеры (`Adr054*AliasController`)
 * + feature flag `ADR054_UNIFIED_API` удалены: фронт полностью на
 * unified URL (build 5fe97a82), legacy путей в продакшен-трафике
 * больше нет.
 *
 * Модуль теперь экспортирует только сервисы и guard, которые нужны
 * unified-контроллерам в `LessonsModule` для делегации:
 *   - `UserCoursesService` / `UserLessonsService` /
 *     `UserLessonStepsService` / `UserProgressService` —
 *     инкапсулируют CRUD пользовательских курсов; пока работают на
 *     `user_*`-таблицах (Phase E2 переключит на единые таблицы и
 *     тогда `user_*` будут дропнуты в Phase E3).
 *   - `UserCourseOwnerGuard` — owner-checks через `@UserCourseResource`.
 *   - `SlugService` — генерация slug'ов.
 *
 * `RedisModule` не импортируется явно: он `@Global()`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    UserProgressService,
    UserCourseOwnerGuard,
    SlugService,
  ],
  exports: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    UserProgressService,
    UserCourseOwnerGuard,
    SlugService,
  ],
})
export class UserCoursesModule {}
