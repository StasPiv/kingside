import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProgressService } from './progress.service';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserProgressService } from './user-courses/user-progress.service';
import { UpdateStepProgressDto } from './dto/update-step-progress.dto';
import { CompleteLessonDto } from './dto/complete-lesson.dto';
import { PuzzleAttemptDto } from './dto/puzzle-attempt.dto';
import {
  Adr054UnifiedStepProgressBody,
  Adr054UnifiedCompleteLessonBody,
} from './dto/adr054-unified-progress.dto';

@UseGuards(JwtAuthGuard)
@Controller('lessons/progress')
export class ProgressController {
  constructor(
    private readonly progressService: ProgressService,
    private readonly adaptive: AdaptiveDifficultyService,
    private readonly userProgressService: UserProgressService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Legacy системные routes (lessonId в body) ─────────────────────
  // KS-2646: остаются на 1 релиз для обратной совместимости. Frontend
  // в Phase D переключится на унифицированную форму с :lessonId в URL.

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

  // ─── KS-2646 / ADR-054 Phase D fix — унифицированная форма ──────────
  // `:lessonId` в URL вместо body. Один маршрут обслуживает и системные,
  // и пользовательские уроки: lesson-type определяется через
  // `prisma.lesson.findUnique` — если найден, идём системным сервисом;
  // иначе fallback на UserProgressService (пользовательский урок).
  // Это убирает у фронта необходимость держать две разные ручки.
  //
  // Дубль routes в `Adr054UnifiedProgressController` снят, чтобы Nest
  // не упирался в route-конфликт (один путь = один controller).

  /** POST /api/lessons/progress/lessons/:lessonId/step. */
  @Post('lessons/:lessonId/step')
  async unifiedUpdateStep(
    @Request() req: AuthenticatedRequest,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: Adr054UnifiedStepProgressBody,
  ) {
    if (await this.isSystemLesson(lessonId)) {
      return this.progressService.updateStep(
        req.user.id,
        lessonId,
        dto.stepId,
        dto.state,
      );
    }
    // Пользовательский урок (или несуществующий): UserProgressService
    // сам кинет 404 для несуществующего/недоступного.
    return this.userProgressService.updateStepProgress(
      req.user.id,
      lessonId,
      dto.stepId,
      dto.state,
    );
  }

  /** POST /api/lessons/progress/lessons/:lessonId/complete. */
  @Post('lessons/:lessonId/complete')
  async unifiedComplete(
    @Request() req: AuthenticatedRequest,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: Adr054UnifiedCompleteLessonBody,
  ) {
    if (await this.isSystemLesson(lessonId)) {
      return this.progressService.completeLesson(
        req.user.id,
        lessonId,
        dto.score,
        dto.quality,
      );
    }
    return this.userProgressService.completeLesson(
      req.user.id,
      lessonId,
      dto.score,
    );
  }

  /**
   * Узкий select по системной таблице `Lesson` — для определения,
   * куда роутить унифицированный запрос. ADR-054 Phase E: после drop
   * `user_lessons` этот метод схлопнется в `return true` (всё —
   * системные).
   */
  private async isSystemLesson(lessonId: string): Promise<boolean> {
    const sys = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true },
    });
    return sys !== null;
  }
}
