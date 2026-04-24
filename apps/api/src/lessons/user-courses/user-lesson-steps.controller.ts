import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { UpdateUserLessonStepRequest } from '@kingside/shared';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
} from './user-course-owner.guard';
import { UserLessonStepsService } from './user-lesson-steps.service';

/**
 * REST-эндпоинты отдельных шагов пользовательского урока (ADR-026 §2.5,
 * KS-1829). Только owner.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/user-lesson-steps')
export class UserLessonStepsController {
  constructor(private readonly service: UserLessonStepsService) {}

  /** PATCH /lessons/user-lesson-steps/:id — обновить `payload` / `order`. */
  @Patch(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('step')
  update(
    @Param('id') id: string,
    @Body() body: UpdateUserLessonStepRequest,
  ) {
    return this.service.update(id, body);
  }

  /** DELETE /lessons/user-lesson-steps/:id — 204. */
  @Delete(':id')
  @UseGuards(UserCourseOwnerGuard)
  @UserCourseResource('step')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.service.delete(id);
  }
}
