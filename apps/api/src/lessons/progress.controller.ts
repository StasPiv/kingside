import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProgressService } from './progress.service';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import { UpdateStepProgressDto } from './dto/update-step-progress.dto';
import { CompleteLessonDto } from './dto/complete-lesson.dto';
import { PuzzleAttemptDto } from './dto/puzzle-attempt.dto';

@UseGuards(JwtAuthGuard)
@Controller('lessons/progress')
export class ProgressController {
  constructor(
    private readonly progressService: ProgressService,
    private readonly adaptive: AdaptiveDifficultyService,
  ) {}

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
    return this.progressService.completeLesson(
      req.user.id,
      dto.lessonId,
      dto.score,
      dto.quality,
    );
  }

  /**
   * POST /api/lessons/progress/puzzle-attempt — зафиксировать попытку для
   * адаптивной сложности (L-33 / KS-1803). Обновляет серию результатов
   * и таргет-рейтинг в `stepsState.__adaptive[stepId]`. Возвращает обновлённое
   * состояние, чтобы клиент мог показать текущий target-рейтинг.
   */
  @Post('puzzle-attempt')
  puzzleAttempt(
    @Request() req: AuthenticatedRequest,
    @Body() dto: PuzzleAttemptDto,
  ) {
    return this.adaptive.recordAttempt(
      req.user.id,
      dto.lessonId,
      dto.stepId,
      dto.puzzleId,
      dto.solved,
      dto.timeSpent,
    );
  }
}
