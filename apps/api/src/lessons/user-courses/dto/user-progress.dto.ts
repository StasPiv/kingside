import {
  IsIn,
  IsNumber,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type {
  CompleteUserLessonRequest,
  UpdateUserStepProgressRequest,
} from '@kingside/shared';

/**
 * POST /lessons/user-progress/step — отметить состояние шага
 * (ADR-026 §2.5). `stepId` — произвольная строка (в БД UserLessonStep.id
 * — UUID v4, но допускаем и lesson-level «stub» при необходимости).
 * `state` whitelist'ится по LessonStepState без `pending|in_progress`
 * (эти состояния задаются клиентом неявно).
 */
export class UpdateUserStepProgressDto implements UpdateUserStepProgressRequest {
  @IsUUID()
  userLessonId!: string;

  @IsUUID()
  stepId!: string;

  @IsIn(['done', 'failed', 'skipped'])
  state!: 'done' | 'failed' | 'skipped';
}

/**
 * POST /lessons/user-progress/lesson/complete — финальное завершение
 * урока (ADR-026 §2.5). `score` — доля успехов 0..1 (UI считает сам).
 */
export class CompleteUserLessonDto implements CompleteUserLessonRequest {
  @IsUUID()
  userLessonId!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  score!: number;
}
