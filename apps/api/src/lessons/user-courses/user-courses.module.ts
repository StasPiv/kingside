import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PuzzleModule } from '../../puzzle/puzzle.module';
import { AnalysisModule } from '../../analysis/analysis.module';
import { UserCoursesService } from './user-courses.service';
import { UserLessonsService } from './user-lessons.service';
import { UserLessonStepsService } from './user-lesson-steps.service';
import { UserProgressService } from './user-progress.service';
import { UserCourseOwnerGuard } from './user-course-owner.guard';
import { SlugService } from './slug.service';
import { GameStepHydratorService } from '../dto/game-step.hydrator';
import { LessonAssistantTools } from './lesson-assistant-tools.service';
import { McpModule as McpDiscoveryModule } from '../../mcp/decorators';

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
 *
 * KS-2954 (ADR-061 §8): MCP-секция `user_courses`. Сам модуль после
 * KS-2647 (Phase E1) не имеет собственных контроллеров — unified-роуты
 * живут в `LessonsModule` (раздел `lessons`). Секция оставлена в
 * каталоге для системного промта ассистента — отдельная концепция в
 * UI «пользовательские курсы».
 */
@McpDiscoveryModule({
  section: 'user_courses',
  title: 'Пользовательские курсы',
  description:
    'Пользовательские курсы — авторские курсы, создаваемые игроками. ' +
    'HTTP-эндпоинты живут под унифицированным /lessons/* (см. lessons), ' +
    'здесь только концепция для системного промта.',
  defaultAuth: 'optional',
})
@Module({
  // KS-3221: PuzzleModule нужен для `find_puzzles_preview`.
  // KS-3224: AnalysisModule нужен для `list_my_analyses` +
  // `add_game_step_from_analysis` (owner-check на Analysis делает
  // GameStepHydratorService, AnalysisService используется только для
  // листинга).
  imports: [PrismaModule, PuzzleModule, AnalysisModule],
  // KS-3213: LessonAssistantTools — теперь @Controller с HTTP-роутами
  // под `/lessons/ai-tools/*`. @McpTool на каждом методе включает их в
  // /_mcp/tools, чтобы внешний webhook-MCP-сервер видел tools.
  controllers: [LessonAssistantTools],
  providers: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    UserProgressService,
    UserCourseOwnerGuard,
    SlugService,
    GameStepHydratorService,
  ],
  exports: [
    UserCoursesService,
    UserLessonsService,
    UserLessonStepsService,
    UserProgressService,
    UserCourseOwnerGuard,
    SlugService,
    GameStepHydratorService,
  ],
})
export class UserCoursesModule {}
