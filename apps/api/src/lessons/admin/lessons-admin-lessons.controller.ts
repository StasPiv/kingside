import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminEmailGuard } from '../../auth/admin-email.guard';
import {
  UserRateLimit,
  UserRateLimitGuard,
} from '../../common/user-rate-limit.guard';
import { LessonsAdminService } from './lessons-admin.service';
import {
  CreateAdminLessonDto,
  ReorderAdminLessonsDto,
  UpdateAdminLessonDto,
} from './dto/admin-lesson.dto';
import { ADMIN_RATE_LIMIT } from './admin-rate-limit';

/**
 * KS-1962/B-6 — admin CRUD для уроков.
 *
 * Пути расщеплены: создание / reorder привязаны к курсу
 * (`/courses/:courseId/lessons[...]`), точечные операции — к id урока
 * (`/lessons/:id`). Это удобно для админ-UI (см. §3.1 концепта).
 *
 * Базовый префикс — `/api/lessons/admin`. Гарды совпадают с
 * `LessonsAdminController` (JwtAuthGuard → AdminEmailGuard).
 */
@UseGuards(JwtAuthGuard, AdminEmailGuard, UserRateLimitGuard)
@UserRateLimit(ADMIN_RATE_LIMIT.maxRequests, ADMIN_RATE_LIMIT.windowSec)
@Controller('lessons/admin')
export class LessonsAdminLessonsController {
  constructor(private readonly service: LessonsAdminService) {}

  /**
   * POST /api/lessons/admin/courses/:courseId/lessons/reorder
   *
   * Объявлен ВЫШЕ `:id`-роутов, чтобы Nest не пробовал интерпретировать
   * `reorder` как `:id` (ParseUUIDPipe упал бы).
   */
  @Post('courses/:courseId/lessons/reorder')
  @HttpCode(204)
  async reorder(
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() dto: ReorderAdminLessonsDto,
  ): Promise<void> {
    await this.service.reorderLessons(courseId, dto);
  }

  /** POST /api/lessons/admin/courses/:courseId/lessons — создать урок. */
  @Post('courses/:courseId/lessons')
  create(
    @Param('courseId', new ParseUUIDPipe({ version: '4' })) courseId: string,
    @Body() dto: CreateAdminLessonDto,
  ) {
    return this.service.createLesson(courseId, dto);
  }

  /** GET /api/lessons/admin/lessons/:id — урок + список шагов. */
  @Get('lessons/:id')
  getById(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.service.getLessonById(id);
  }

  /** PATCH /api/lessons/admin/lessons/:id — изменить метаданные урока. */
  @Patch('lessons/:id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateAdminLessonDto,
  ) {
    return this.service.updateLesson(id, dto);
  }

  /**
   * DELETE /api/lessons/admin/lessons/:id — каскадно удалить урок
   * (LessonStep + UserLessonProgress; cascade в БД).
   */
  @Delete('lessons/:id')
  @HttpCode(204)
  async delete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    await this.service.deleteLesson(id);
  }
}
