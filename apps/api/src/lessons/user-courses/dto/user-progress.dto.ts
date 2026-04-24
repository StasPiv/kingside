import { IsIn, IsNumber, IsUUID, Max, Min } from 'class-validator';
import type {
  CompleteUserLessonRequest,
  UpdateUserStepProgressRequest,
} from '@kingside/shared';

/**
 * POST /lessons/user-progress/lessons/:userLessonId/step — отметить
 * состояние шага (ADR-026 §2.5). `userLessonId` идёт в path, в body —
 * только `stepId` и `state`.
 *
 * `state` whitelist'ится подмножеством `LessonStepState` без
 * `pending|in_progress` — эти состояния не пишем, они подразумеваемые.
 */
export class UpdateUserStepProgressDto implements UpdateUserStepProgressRequest {
  @IsUUID()
  stepId!: string;

  @IsIn(['done', 'failed', 'skipped'])
  state!: 'done' | 'failed' | 'skipped';
}

/**
 * POST /lessons/user-progress/lessons/:userLessonId/complete — финальное
 * завершение урока. `score` — доля успехов 0..1 (UI считает сам).
 */
export class CompleteUserLessonDto implements CompleteUserLessonRequest {
  @IsNumber()
  @Min(0)
  @Max(1)
  score!: number;
}
