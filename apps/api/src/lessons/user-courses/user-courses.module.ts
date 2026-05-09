import { Module, type Type } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserCoursesController } from './user-courses.controller';
import { UserCoursesPublicController } from './user-courses-public.controller';
import { UserLessonsController } from './user-lessons.controller';
import { UserLessonStepsController } from './user-lesson-steps.controller';
import { UserProgressController } from './user-progress.controller';
import { UserCoursesService } from './user-courses.service';
import { UserLessonsService } from './user-lessons.service';
import { UserLessonStepsService } from './user-lesson-steps.service';
import { UserProgressService } from './user-progress.service';
import { UserCourseOwnerGuard } from './user-course-owner.guard';
import { SlugService } from './slug.service';
import { isAdr054UnifiedApi } from '../adr054.config';
import {
  Adr054UserCoursesAliasController,
  Adr054UserLessonsAliasController,
  Adr054UserLessonStepsAliasController,
  Adr054UserProgressAliasController,
} from '../adr054-alias.controller';

/**
 * UserCoursesModule — пользовательские курсы (ADR-026, KS-1829).
 *
 * KS-2642 / ADR-054 Phase C. Регистрация контроллеров условная:
 *
 *   - `ADR054_UNIFIED_API !== 'true'` (default) — режим Phase A/B:
 *     legacy-контроллеры активны и пишут в `user_*` таблицы. Это
 *     безопасный rollback-режим, в котором мы выезжаем в prod.
 *
 *   - `ADR054_UNIFIED_API === 'true'` — Phase C alias-режим:
 *     legacy-роуты заменяются на `Adr054*AliasController`-ы, которые
 *     возвращают `308 Permanent Redirect` на унифицированные
 *     `/lessons/*` URL. Унифицированные обрабатываются объединёнными
 *     контроллерами поверх единых таблиц.
 *
 * Сервисы (`UserCoursesService` etc.) остаются в provider'ах при любом
 * флаге — старые spec'и и потенциальные внутренние потребители (тесты,
 * scripts) их используют. Это не утяжеляет продакшен: сервисы DI-мы
 * только при явной инжекции в контроллер.
 *
 * `RedisModule` не импортируется явно: он `@Global()`, доступен в DI.
 */
const legacyControllers: Type<unknown>[] = [
  // KS-1918: PublicController зарегистрирован ПЕРЕД
  // UserCoursesController — чтобы `/authors` matched как литерал,
  // а не подцепился `:slug`-роутом приватного контроллера.
  UserCoursesPublicController,
  UserCoursesController,
  UserLessonsController,
  UserLessonStepsController,
  UserProgressController,
];

const aliasControllers: Type<unknown>[] = [
  Adr054UserCoursesAliasController,
  Adr054UserLessonsAliasController,
  Adr054UserLessonStepsAliasController,
  Adr054UserProgressAliasController,
];

@Module({
  imports: [PrismaModule],
  controllers: isAdr054UnifiedApi() ? aliasControllers : legacyControllers,
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
    SlugService,
  ],
})
export class UserCoursesModule {}
