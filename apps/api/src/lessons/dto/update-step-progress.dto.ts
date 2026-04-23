import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import type { LessonStepState, UpdateLessonStepRequest } from '@kingside/shared';

/**
 * POST /api/lessons/progress/step — отметка прогресса одного шага.
 *
 * `lessonId` дополнительно передаём здесь (а не в URL), потому что путь
 * по Gherkin — `/api/lessons/progress/step`, без `lessonId` в path.
 */
export class UpdateStepProgressDto implements UpdateLessonStepRequest {
  @IsUUID()
  lessonId!: string;

  @IsString()
  stepId!: string;

  @IsIn(['pending', 'in_progress', 'done', 'failed', 'skipped'])
  state!: LessonStepState;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  score?: number;
}
