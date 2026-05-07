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
}
