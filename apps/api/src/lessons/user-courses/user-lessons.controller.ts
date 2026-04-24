import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UpdateUserLessonDto } from './dto/user-lesson.dto';
import {
  CreateUserLessonStepDto,
  ReorderUserStepsDto,
} from './dto/user-lesson-step.dto';
import {
  CompleteUserLessonDto,
  UpdateUserStepProgressDto,
} from './dto/user-progress.dto';
import { AuthenticatedRequest } from '../../common/authenticated-request';
import { UserRateLimit, UserRateLimitGuard } from '../../common/user-rate-limit.guard';
import { USER_COURSES_RATE_LIMITS } from './rate-limits';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
} from './user-course-owner.guard';
import { UserLessonsService } from './user-lessons.service';

/**
 * REST-эндпоинты уроков пользовательских курсов + прогресс (ADR-026 §2.5,
 * KS-1829).
 *
 * Семантически контроллер объединяет три префикса — `user-lessons`,
 * `user-lesson-steps` (reorder — единственный POST здесь; PATCH/DELETE
 * шагов вынесены в `UserLessonStepsController`) и `user-progress`.
 * Задача жёстко требует 3 контроллера на 15 роутов, поэтому прогресс
 * живёт здесь; BE-4 вытащит его в отдельный UserProgressController,
 * если так будет чище. Сейчас это happy-path заглушка.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class UserLessonsController {
  constructor(private readonly service: UserLessonsService) {}

  // ─── /lessons/user-lessons/:id ─────────────────────────────────────

  /** GET /lessons/user-lessons/:id — урок + шаги + прогресс. */
  @Get('user-lessons/:id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  getWithSteps(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.service.getWithSteps(req.user.id, id);
  }

  /** PATCH /lessons/user-lessons/:id — только owner. */
  @Patch('user-lessons/:id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  update(
    @Param('id') id: string,
    @Body() body: UpdateUserLessonDto,
  ) {
    return this.service.update(id, body);
  }

  /** DELETE /lessons/user-lessons/:id — только owner, 204. */
  @Delete('user-lessons/:id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }

  /**
   * POST /lessons/user-lessons/:id/steps — добавить шаг.
   * Rate-limit 100 req / 10 мин на userId.
   */
  @Post('user-lessons/:id/steps')
  @UseGuards(UserCourseOwnerGuard, UserRateLimitGuard)
  @UserCourseResource('lesson')
  @UserRateLimit(
    USER_COURSES_RATE_LIMITS.addStep.maxRequests,
    USER_COURSES_RATE_LIMITS.addStep.windowSec,
  )
  addStep(
    @Param('id') id: string,
    @Body() body: CreateUserLessonStepDto,
  ) {
    return this.service.addStep(id, body);
  }

  /**
   * POST /lessons/user-lessons/:id/steps/reorder — массовый `order` для
   * шагов урока в одной транзакции (ADR §2.5).
   */
  @Post('user-lessons/:id/steps/reorder')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('lesson')
  reorderSteps(
    @Param('id') id: string,
    @Body() body: ReorderUserStepsDto,
  ) {
    return this.service.reorderSteps(id, body);
  }

  // ─── /lessons/user-progress/* ─────────────────────────────────────

  /**
   * POST /lessons/user-progress/step — отметить состояние шага.
   * BE-4 допишет полноценную логику; здесь happy-path.
   */
  @Post('user-progress/step')
  updateStepProgress(
    @Request() req: AuthenticatedRequest,
    @Body() body: UpdateUserStepProgressDto,
  ) {
    return this.service.updateStepProgress(req.user.id, body);
  }

  /**
   * POST /lessons/user-progress/lesson/complete — финальное завершение
   * урока. SM-2 к пользовательским курсам не подключён (ADR-026 §2.1),
   * поэтому поля `quality` в теле нет.
   */
  @Post('user-progress/lesson/complete')
  completeLesson(
    @Request() req: AuthenticatedRequest,
    @Body() body: CompleteUserLessonDto,
  ) {
    return this.service.completeLesson(req.user.id, body);
  }
}
