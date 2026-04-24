import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserCoursesController } from './user-courses.controller';
import { UserLessonsController } from './user-lessons.controller';
import { UserLessonStepsController } from './user-lesson-steps.controller';
import { UserCoursesService } from './user-courses.service';
import { UserLessonsService } from './user-lessons.service';
import { UserLessonStepsService } from './user-lesson-steps.service';
import { UserCourseOwnerGuard } from './user-course-owner.guard';
import { SlugService } from './slug.service';

/**
 * UserCoursesModule — пользовательские курсы (ADR-026, KS-1829).
 *
 * `RedisModule` не импортируется явно: он помечен `@Global()`, так что
 * `RedisService` (нужен `UserRateLimitGuard`) доступен в DI без
 * объявления зависимости здесь.
 *
 * `UserCourseOwnerGuard` объявлен как provider, чтобы Nest собрал его
 * единожды и инжектил в любой route через `@UseGuards()`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    UserCoursesController,
    UserLessonsController,
    UserLessonStepsController,
  ],
  providers: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    UserCourseOwnerGuard,
    SlugService,
  ],
  exports: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    SlugService,
  ],
})
export class UserCoursesModule {}
