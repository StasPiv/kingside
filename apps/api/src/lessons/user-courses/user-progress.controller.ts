import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../../common/authenticated-request';
import {
  CompleteUserLessonDto,
  UpdateUserStepProgressDto,
} from './dto/user-progress.dto';
import { UserProgressService } from './user-progress.service';

/**
 * REST-эндпоинты прогресса пользовательских курсов (ADR-026 §2.5,
 * KS-1831). Вынесены из `UserLessonsController` в отдельный
 * контроллер, чтобы держать пути симметричными системному
 * `ProgressController` (тот же шаблон ресурсов).
 *
 * Маршруты:
 *   POST /api/lessons/user-progress/lessons/:userLessonId/step
 *   POST /api/lessons/user-progress/lessons/:userLessonId/complete
 *   GET  /api/lessons/user-progress/courses/:userCourseId
 *   GET  /api/lessons/user-progress/lessons/:userLessonId
 *
 * Доступ:
 *   - `JwtAuthGuard` — все роуты требуют авторизации;
 *   - `UserCourseOwnerGuard` НЕ применяем: прогресс — сущность
 *     текущего пользователя. Сервис сам проверяет «доступен ли ресурс»
 *     (owner ИЛИ isPublic) и кидает 404 при отказе — так любой
 *     авторизованный может играть публичный чужой курс.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/user-progress')
export class UserProgressController {
  constructor(private readonly service: UserProgressService) {}

  /** POST /lessons/user-progress/lessons/:userLessonId/step */
  @Post('lessons/:userLessonId/step')
  updateStep(
    @Request() req: AuthenticatedRequest,
    @Param('userLessonId') userLessonId: string,
    @Body() body: UpdateUserStepProgressDto,
  ) {
    return this.service.updateStepProgress(
      req.user.id,
      userLessonId,
      body.stepId,
      body.state,
    );
  }

  /** POST /lessons/user-progress/lessons/:userLessonId/complete */
  @Post('lessons/:userLessonId/complete')
  completeLesson(
    @Request() req: AuthenticatedRequest,
    @Param('userLessonId') userLessonId: string,
    @Body() body: CompleteUserLessonDto,
  ) {
    return this.service.completeLesson(req.user.id, userLessonId, body.score);
  }

  /**
   * GET /lessons/user-progress/courses/:userCourseId
   * Возвращает `UserCoursePlayProgressDto | null` (null если юзер ещё
   * не начинал курс).
   */
  @Get('courses/:userCourseId')
  getCourseProgress(
    @Request() req: AuthenticatedRequest,
    @Param('userCourseId') userCourseId: string,
  ) {
    return this.service.getCourseProgress(req.user.id, userCourseId);
  }

  /**
   * GET /lessons/user-progress/lessons/:userLessonId
   * Возвращает `UserLessonPlayProgressDto | null`.
   */
  @Get('lessons/:userLessonId')
  getLessonProgress(
    @Request() req: AuthenticatedRequest,
    @Param('userLessonId') userLessonId: string,
  ) {
    return this.service.getLessonProgress(req.user.id, userLessonId);
  }
}
