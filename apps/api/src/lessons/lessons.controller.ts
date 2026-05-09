import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LessonsService } from './lessons.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserLessonsService } from './user-courses/user-lessons.service';

@UseGuards(JwtAuthGuard)
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
  async getOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = req.user?.id ?? null;
    try {
      return await this.lessonsService.getLessonWithSteps(id, userId);
    } catch (e) {
      if (!(e instanceof NotFoundException) || userId === null) {
        throw e;
      }
      // Fallback: пользовательский урок. inline access-check, чтобы не
      // вытаскивать ещё один сервис: достаточно одного `findUnique` с
      // include course для owner_id/is_public.
      const userLesson = await this.prisma.userLesson.findUnique({
        where: { id },
        select: {
          id: true,
          course: { select: { ownerId: true, isPublic: true } },
        },
      });
      if (
        !userLesson ||
        (userLesson.course.ownerId !== userId && !userLesson.course.isPublic)
      ) {
        // Не раскрываем «существует, но недоступен».
        throw new NotFoundException('Lesson not found');
      }
      return this.userLessonsService.getWithSteps(userId, id);
    }
  }
}
