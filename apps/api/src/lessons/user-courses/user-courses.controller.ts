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
import type {
  CreateUserCourseRequest,
  CreateUserLessonRequest,
  UpdateUserCourseRequest,
} from '@kingside/shared';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../../common/authenticated-request';
import { UserRateLimit, UserRateLimitGuard } from '../../common/user-rate-limit.guard';
import { USER_COURSES_RATE_LIMITS } from './rate-limits';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
} from './user-course-owner.guard';
import { UserCoursesService } from './user-courses.service';

/**
 * REST-эндпоинты пользовательских курсов (ADR-026 §2.5, KS-1829).
 *
 * Все пути пишутся без `/api` — глобальный префикс добавляется в
 * `main.ts` (если включён). В dev сейчас префикса нет; Vite-прокси
 * срезает его на фронте.
 *
 * Guard-цепочка:
 *   `JwtAuthGuard` → `UserCourseOwnerGuard` (если роут трогает
 *   конкретный ресурс) → `UserRateLimitGuard` (на create-эндпоинтах).
 * Порядок важен: `UserRateLimitGuard` читает `req.user`.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/user-courses')
export class UserCoursesController {
  constructor(private readonly service: UserCoursesService) {}

  /**
   * GET /lessons/user-courses?mine=1/0
   *
   * `mine=1` (default) — список своих курсов; `mine=0` — список
   * публичных (в MVP — без фильтров/каталога, ADR §2.6). Ответ —
   * `UserCourseListResponse`.
   */
  @Get()
  list(
    @Request() req: AuthenticatedRequest,
    @Query('mine') mine?: string,
  ) {
    // mine по умолчанию true — главная точка входа автора.
    const minePath = mine === undefined ? true : mine !== '0' && mine !== 'false';
    return this.service.list(req.user.id, { mine: minePath });
  }

  /**
   * GET /lessons/user-courses/:slug — курс + короткий список уроков +
   * прогресс текущего пользователя. Guard разрешает owner или публичный
   * (isPublic=true). Для приватного чужого — 404.
   */
  @Get(':slug')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('course-slug')
  getBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ) {
    return this.service.getBySlug(req.user.id, slug);
  }

  /**
   * POST /lessons/user-courses — создать курс. Rate-limit — 5 req / 10 мин
   * на userId (ADR §2.2, KS-1833).
   */
  @Post()
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit(
    USER_COURSES_RATE_LIMITS.createCourse.maxRequests,
    USER_COURSES_RATE_LIMITS.createCourse.windowSec,
  )
  create(
    @Request() req: AuthenticatedRequest,
    @Body() body: CreateUserCourseRequest,
  ) {
    return this.service.create(req.user.id, body);
  }

  /** PATCH /lessons/user-courses/:id — только owner. */
  @Patch(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('course')
  update(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserCourseRequest,
  ) {
    return this.service.update(req.user.id, id, body);
  }

  /** DELETE /lessons/user-courses/:id — только owner. 204. */
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

  /**
   * POST /lessons/user-courses/:id/lessons — добавить урок. Rate-limit
   * 30 req / 10 мин.
   */
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
    @Body() body: CreateUserLessonRequest,
  ) {
    return this.service.addLesson(req.user.id, id, body);
  }
}
