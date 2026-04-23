import { IsNumber, IsUUID, Max, Min } from 'class-validator';
import type { CompleteLessonRequest } from '@kingside/shared';

/**
 * POST /api/lessons/progress/lesson/complete — финальное завершение урока.
 * Порог «пройден» = `score >= 0.7` (ADR-024 §2.3). Проверяется в сервисе.
 */
export class CompleteLessonDto implements CompleteLessonRequest {
  @IsUUID()
  lessonId!: string;

  /** Агрегатный балл 0..1 по stepsState. */
  @IsNumber()
  @Min(0)
  @Max(1)
  score!: number;
}
