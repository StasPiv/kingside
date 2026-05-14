import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { FindPuzzlesQuery } from '@kingside/shared';

const SOLUTION_MODE_VALUES = ['forced-line', 'play-vs-engine'] as const;
type SolutionMode = (typeof SOLUTION_MODE_VALUES)[number];

export class FindPuzzlesDto implements FindPuzzlesQuery {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Max(4000)
  ratingMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /**
   * KS-2472 / ADR-044 §5.5. Whitelist двух значений; любое другое —
   * 400 с class-validator'а (`ValidationPipe` уровня приложения).
   */
  @IsOptional()
  @IsIn(SOLUTION_MODE_VALUES as unknown as string[])
  solutionMode?: SolutionMode;

  /**
   * KS-3032. По умолчанию для PVE-режима (`solutionMode='play-vs-engine'`)
   * `/puzzles/next` исключает любые задачи, по которым у юзера уже есть
   * запись в `puzzle_attempts` (любой статус — solved/failed/abort).
   * Если все задачи в выборке пройдены — 404 `noPuzzlesAvailable`,
   * фронт показывает «Все пройдены».
   *
   * `?includeAttempted=1` (или `true`) → вернуть прежнее каскадное
   * поведение (recent-7d → recent-1d → solved-only → none), допускает
   * перерешать ранее посещённые задачи.
   *
   * Для `forced-line` параметр игнорируется (там каскад всегда уместен —
   * forced-line задач много, и пользователь обычно их повторяет осознанно).
   */
  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  includeAttempted?: string;
}
