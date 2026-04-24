import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/**
 * POST /api/lessons/progress/puzzle-attempt — зафиксировать результат
 * одной попытки внутри `PuzzleStep` для адаптивной сложности (L-33 / KS-1803).
 *
 * Не дублирует `PuzzleAttempt` (puzzle-модуль) — только обновляет серию
 * (`UserLessonProgress.stepsState.__adaptive[stepId]`), по которой
 * адаптивный резолвер выбирает следующую задачу.
 */
export class PuzzleAttemptDto {
  @IsUUID()
  lessonId!: string;

  @IsString()
  stepId!: string;

  @IsString()
  puzzleId!: string;

  @IsBoolean()
  solved!: boolean;

  /** Время на попытку, миллисекунды. Пока не влияет на правила. */
  @IsOptional()
  @IsInt()
  @Min(0)
  timeSpent?: number;
}
