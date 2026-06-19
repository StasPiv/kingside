/**
 * KS-4342 / ADR-135 §2.4. Query-DTO для `GET /tactic-puzzles/browse`.
 * Все поля опциональны. Cursor — opaque base64-токен от прошлого
 * ответа; невалидный → начинаем с начала.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type {
  TacticPuzzleBrowseQuery,
  TacticPuzzleObjective,
} from '@kingside/shared';

const OBJECTIVES: TacticPuzzleObjective[] = [
  'convertAdvantage',
  'saveEquality',
];

export class BrowseTacticPuzzlesDto implements TacticPuzzleBrowseQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(OBJECTIVES)
  objective?: TacticPuzzleObjective;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  maiaDifficultyMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  gapMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMax?: number;

  /** `?themes=a,b,c` — CSV; client может также отправить `?themes=a&themes=b`. */
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value.flatMap((v: unknown) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      );
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return undefined;
  })
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}
