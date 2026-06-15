import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { LessonsService } from './lessons.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserLessonsService } from './user-courses/user-lessons.service';

/**
 * KS-4130 / ADR-128 §6.8.2: class-level `JwtAuthGuard` снят. `GET /:id`
 * открыт гостю через `OptionalJwtGuard` + rate-limit 60/min — урок
 * системного курса должен открываться без логина для SEO/витрины.
 * Fallback в пользовательские уроки сохраняется только для авторизованных.
 */
@Controller('lessons/lessons')
export class LessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly userLessonsService: UserLessonsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/lessons/lessons/:id — урок с шагами + прогресс пользователя.
   *
   * KS-2646 / ADR-054 Phase D fix. Если урок не найден в системной
   * таблице `Lesson`, делаем fallback на `user_lessons` (пользовательский
   * урок), но **только** если пользователь имеет к нему доступ:
   *   - `course.ownerId === userId` (свой урок), или
   *   - `course.isPublic === true` (публичный курс другого автора).
   * Чужой приватный → 404 (не раскрываем существование).
   *
   * Аноним (`userId === null`) fallback не получает — UserLessonsService
   * требует userId, и публичные приватные пользовательские уроки в
   * MVP всегда требуют логина (см. ADR-026 §2.6).
   */
  @Get(':id')
  @UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
  @RateLimit(60, 60)
  async getOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('locale') locale?: string,
  ) {
    const userId = req.user?.id ?? null;
    try {
      // KS-4145: query locale побеждает User.locale, lessons.service
      // подменяет lesson на sibling-перевод при необходимости.
      return await this.lessonsService.getLessonWithSteps(id, userId, locale);
    } catch (e) {
      if (!(e instanceof NotFoundException) || userId === null) {
        throw e;
      }
      // KS-2649 / Phase E3: fallback ищет в единой `lessons` (с
      // `ownerId IS NOT NULL`); legacy `user_lessons` дропнута. inline
      // access-check, чтобы не тянуть ещё один сервис.
      const userLesson = await this.prisma.lesson.findUnique({
        where: { id },
        select: {
          id: true,
          ownerId: true,
          course: { select: { ownerId: true, isPublic: true } },
        },
      });
      if (
        !userLesson ||
        userLesson.ownerId === null || // системный — обрабатывается основным путём
        (userLesson.course.ownerId !== userId && !userLesson.course.isPublic)
      ) {
        // Не раскрываем «существует, но недоступен».
        throw new NotFoundException('Lesson not found');
      }
      return this.userLessonsService.getWithSteps(userId, id);
    }
  }
}
