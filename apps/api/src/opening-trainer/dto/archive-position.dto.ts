/**
 * KS-3469 / ADR-090 §4.2. Query DTO для GET /opening-trainer/archive-position/games.
 * Все поля опциональны; defaults применяются в proxy-сервисе.
 */
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  ArchiveBucket,
  ArchiveGameColor,
  ArchiveGameResult,
  ArchiveGamesSort,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSort[] = ['recent', 'topElo'];
const COLOR_VALUES: ArchiveGameColor[] = ['white', 'black', 'any'];
const BUCKET_VALUES: ArchiveBucket[] = ['master', 'user'];
const TCC_VALUES: ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

export class ArchivePositionGamesQueryDto {
  @IsString()
  fen!: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsIn(BUCKET_VALUES)
  bucket?: ArchiveBucket;

  @IsOptional()
  @IsIn(SORT_VALUES)
  sort?: ArchiveGamesSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4000)
  minElo?: number;

  @IsOptional()
  @IsIn(TCC_VALUES)
  timeControlCategory?: ArchiveTimeControlCategory;

  @IsOptional()
  @IsIn(COLOR_VALUES)
  color?: ArchiveGameColor;

  @IsOptional()
  @IsIn(RESULT_VALUES)
  result?: ArchiveGameResult;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsString()
  move?: string;

  @IsOptional()
  @IsString()
  player?: string;

  @IsOptional()
  @IsString()
  eco?: string;
}
