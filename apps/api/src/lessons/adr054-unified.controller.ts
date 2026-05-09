/**
 * KS-2643 / ADR-054 §4 Phase C2 — унифицированные роуты под `/lessons/*`.
 *
 * Контроллеры обрабатывают новые URL, на которые legacy-alias из
 * `Adr054*AliasController` редиректит при включённом фича-флаге
 * `ADR054_UNIFIED_API=true` (см. `adr054-alias.controller.ts`).
 *
 * Прагматика реализации: вместо переписывания CRUD-логики поверх
 * единых таблиц мы делегируем на существующие `UserCoursesService` /
 * `UserLessonsService` / `UserLessonStepsService` / `UserProgressService`,
 * которые уже покрыты тестами и работают через `user_*`-таблицы. Эти
 * таблицы держатся синхронно с `courses/lessons/lesson_steps` (Phase B
 * скопировал данные, Phase E удалит legacy). Унификация на уровне
 * controller'ов даёт единый URL-namespace и snapshot-точку для Phase D
 * (frontend), без переписывания сервисного слоя.
 *
 * После Phase E (drop user_* таблиц) сервисы переключатся на единые
 * таблицы — это локальное изменение `UserCoursesService` и т.д. без
 * касания этих контроллеров.
 *
 * Guards: используем существующий `UserCourseOwnerGuard` (он уже
 * проверяет owner/public/admin — то же, что декларирует
 * `LessonsAccessGuard` из KS-2642 каркаса). Единый guard `LessonsAccessGuard`
 * остаётся в коде для будущей унификации; в этой подзадаче не
 * перетаскиваем legacy-роуты на него — это бы перенесло на нас риск
 * регрессии в guard-логике, а acceptance-задача — про URL.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  UserRateLimit,
  UserRateLimitGuard,
} from '../common/user-rate-limit.guard';
import {
  CreateUserCourseDto,
  ListUserCoursesQueryDto,
  UpdateUserCourseDto,
} from './user-courses/dto/user-course.dto';
import {
  CreateUserLessonDto,
  ReorderUserLessonsDto,
  UpdateUserLessonDto,
} from './user-courses/dto/user-lesson.dto';
import {
  CreateUserLessonStepDto,
  ReorderUserStepsDto,
  UpdateUserLessonStepDto,
} from './user-courses/dto/user-lesson-step.dto';
import {
  CompleteUserLessonDto,
  UpdateUserStepProgressDto,
} from './user-courses/dto/user-progress.dto';
import { USER_COURSES_RATE_LIMITS } from './user-courses/rate-limits';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
} from './user-courses/user-course-owner.guard';
import { UserCoursesService } from './user-courses/user-courses.service';
import { UserLessonsService } from './user-courses/user-lessons.service';
import { UserLessonStepsService } from './user-courses/user-lesson-steps.service';
import { UserProgressService } from './user-courses/user-progress.service';

// ─── /lessons/courses — POST/PATCH/DELETE + nested lessons ────────────
//
// GET-роуты `/lessons/courses` и `/lessons/courses/:slug` остаются у
// `CoursesController` — он их расширен отдельно (см. courses.controller.ts).
// Контроллер ниже намеренно **не объявляет GET**, чтобы не было
// route-конфликтов с `CoursesController`.
@UseGuards(JwtAuthGuard)
@Controller('lessons/courses')
export class Adr054UnifiedCoursesController {
  constructor(private readonly service: UserCoursesService) {}

  /** GET /lessons/courses/enrolled — «курсы, которые я прохожу». */
  @Get('enrolled')
  listEnrolled(@Request() req: AuthenticatedRequest) {
    return this.service.listEnrolled(req.user.id);
  }

  /**
   * POST /lessons/courses — создать пользовательский курс.
   * Rate-limit 5 req / 10 мин (KS-1833).
   */
  @Post()
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit(
    USER_COURSES_RATE_LIMITS.createCourse.maxRequests,
    USER_COURSES_RATE_LIMITS.createCourse.windowSec,
  )
  create(
    @Request() req: AuthenticatedRequest,
    @Body() body: CreateUserCourseDto,
  ) {
    return this.service.create(req.user.id, body);
  }

  /** PATCH /lessons/courses/:id — owner-only. */
  @Patch(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('course')
  update(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserCourseDto,
  ) {
    return this.service.update(req.user.id, id, body);
  }

  /** DELETE /lessons/courses/:id — owner-only. 204. */
  @Delete(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('course')
  @HttpCode(204)
  async delete(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.service.delete(req.user.id, id);
  }

  /** POST /lessons/courses/:id/lessons — добавить урок. */
  @Post(':id/lessons')
  @UseGuards(UserCourseOwnerGuard, UserRateLimitGuard)
  @UserCourseResource('course')
  @UserRateLimit(
    USER_COURSES_RATE_LIMITS.addLesson.maxRequests,
    USER_COURSES_RATE_LIMITS.addLesson.windowSec,
  )
  addLesson(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CreateUserLessonDto,
  ) {
    return this.service.addLesson(req.user.id, id, body);
  }

  /** POST /lessons/courses/:id/lessons/reorder — массовый order. */
  @Post(':id/lessons/reorder')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('course')
  reorderLessons(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ReorderUserLessonsDto,
  ) {
    return this.service.reorderLessons(req.user.id, id, body);
  }
}

// ─── /lessons/lessons — PATCH/DELETE + nested steps ───────────────────
//
// GET `/lessons/lessons/:id` системных уже у `LessonsController`. Для
// пользовательских уроков возвращаем 200 через делегацию — добавляем
// маршрут с другим path: `/lessons/lessons/:id/own`. Альтернативно
// frontend может определить «свой урок vs системный» по `course.ownerId`
// после получения, либо хитрить через extras на стороне Phase D.
@UseGuards(JwtAuthGuard)
@Controller('lessons/lessons')
export class Adr054UnifiedLessonsController {
  constructor(private readonly service: UserLessonsService) {}

  /** GET /lessons/lessons/:id/own — пользовательский урок + шаги + прогресс. */
  @Get(':id/own')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  getWithSteps(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.service.getWithSteps(req.user.id, id);
  }

  /** PATCH /lessons/lessons/:id — owner-only. */
  @Patch(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  update(@Param('id') id: string, @Body() body: UpdateUserLessonDto) {
    return this.service.update(id, body);
  }

  /** DELETE /lessons/lessons/:id — 204. */
  @Delete(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }

  /** POST /lessons/lessons/:id/steps — добавить шаг. */
  @Post(':id/steps')
  @UseGuards(UserCourseOwnerGuard, UserRateLimitGuard)
  @UserCourseResource('lesson')
  @UserRateLimit(
    USER_COURSES_RATE_LIMITS.addStep.maxRequests,
    USER_COURSES_RATE_LIMITS.addStep.windowSec,
  )
  addStep(@Param('id') id: string, @Body() body: CreateUserLessonStepDto) {
    return this.service.addStep(id, body);
  }

  /** POST /lessons/lessons/:id/steps/reorder — массовый reorder. */
  @Post(':id/steps/reorder')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  reorderSteps(@Param('id') id: string, @Body() body: ReorderUserStepsDto) {
    return this.service.reorderSteps(id, body);
  }
}

// ─── /lessons/steps — PATCH/DELETE отдельного шага ─────────────────────
@UseGuards(JwtAuthGuard)
@Controller('lessons/steps')
export class Adr054UnifiedLessonStepsController {
  constructor(private readonly service: UserLessonStepsService) {}

  /** PATCH /lessons/steps/:id. */
  @Patch(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('step')
  update(@Param('id') id: string, @Body() body: UpdateUserLessonStepDto) {
    return this.service.update(id, body);
  }

  /** DELETE /lessons/steps/:id. 204. */
  @Delete(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('step')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }
}

// ─── /lessons/progress — пользовательский прогресс ─────────────────────
//
// Базовый префикс совпадает с системным `ProgressController`, но методы
// /пути отличаются (системный: POST `step` / `lesson/complete`;
// пользовательский: POST `lessons/:id/{step,complete}`, GET `courses/:id`,
// GET `lessons/:id`). Nest-конфликта нет.
@UseGuards(JwtAuthGuard)
@Controller('lessons/progress')
export class Adr054UnifiedProgressController {
  constructor(private readonly service: UserProgressService) {}

  /** POST /lessons/progress/lessons/:id/step. */
  @Post('lessons/:id/step')
  updateStep(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserStepProgressDto,
  ) {
    return this.service.updateStepProgress(req.user.id, id, body.stepId, body.state);
  }

  /** POST /lessons/progress/lessons/:id/complete. */
  @Post('lessons/:id/complete')
  completeLesson(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CompleteUserLessonDto,
  ) {
    return this.service.completeLesson(req.user.id, id, body.score);
  }

  /** GET /lessons/progress/courses/:id. */
  @Get('courses/:id')
  getCourseProgress(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.service.getCourseProgress(req.user.id, id);
  }

  /** GET /lessons/progress/lessons/:id. */
  @Get('lessons/:id')
  getLessonProgress(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.service.getLessonProgress(req.user.id, id);
  }
}

// Lint-suppress: импорт `ListUserCoursesQueryDto` нужен для возможного
// расширения `Adr054UnifiedCoursesController` GET-роутом с фильтром
// `mine`/`limit`/`offset` — отложили на C3, оставляем импорт чтобы
// reorganize не выкинул.
void ListUserCoursesQueryDto;
void Query;
