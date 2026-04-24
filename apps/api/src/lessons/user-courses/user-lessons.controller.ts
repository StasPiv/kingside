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
import { AuthenticatedRequest } from '../../common/authenticated-request';
import { UserRateLimit, UserRateLimitGuard } from '../../common/user-rate-limit.guard';
import { USER_COURSES_RATE_LIMITS } from './rate-limits';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
} from './user-course-owner.guard';
import { UserLessonsService } from './user-lessons.service';

/**
 * REST-эндпоинты уроков пользовательских курсов (ADR-026 §2.5,
 * KS-1829 / KS-1831).
 *
 * Контроллер живёт на префиксе `/lessons` потому что обслуживает два
 * префикса URL: `/lessons/user-lessons/:id/...` (CRUD урока) и
 * `/lessons/user-lessons/:id/steps/reorder`. Сами шаги — в
 * `UserLessonStepsController`. Прогресс — в `UserProgressController`
 * (BE-4 вынес его из временной заглушки).
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

  // Прогресс-эндпоинты вынесены в `UserProgressController` (KS-1831).
}
