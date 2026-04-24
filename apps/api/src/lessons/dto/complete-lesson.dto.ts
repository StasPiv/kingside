import { IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { CompleteLessonRequest } from '@kingside/shared';

/**
 * POST /api/lessons/progress/lesson/complete — финальное завершение урока.
 * Порог «пройден» = `score >= 0.7` (ADR-024 §2.3). Проверяется в сервисе.
 * `quality` (0..5) — опциональное переопределение SM-2 quality для UI
 * повторений (L-22); если не передан — считается из `score` через
 * `Sm2Service.scoreToQuality`.
 */
export class CompleteLessonDto implements CompleteLessonRequest {
  @IsUUID()
  lessonId!: string;

  /** Агрегатный балл 0..1 по stepsState. */
  @IsNumber()
  @Min(0)
  @Max(1)
  score!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  quality?: number;
}
