import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProgressService } from './progress.service';
import { UpdateStepProgressDto } from './dto/update-step-progress.dto';
import { CompleteLessonDto } from './dto/complete-lesson.dto';

@UseGuards(JwtAuthGuard)
@Controller('lessons/progress')
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  /** POST /api/lessons/progress/step — отметить состояние шага. */
  @Post('step')
  updateStep(
    @Request() req: AuthenticatedRequest,
    @Body() dto: UpdateStepProgressDto,
  ) {
    return this.progressService.updateStep(
      req.user.id,
      dto.lessonId,
      dto.stepId,
      dto.state,
    );
  }

  /**
   * POST /api/lessons/progress/lesson/complete — финальное завершение
   * урока (порог ≥70% проверяет сервис).
   */
  @Post('lesson/complete')
  completeLesson(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CompleteLessonDto,
  ) {
    return this.progressService.completeLesson(req.user.id, dto.lessonId, dto.score);
  }
}
