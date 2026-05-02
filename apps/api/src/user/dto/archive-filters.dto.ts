import {
  IsOptional,
  IsString,
  IsNumber,
  IsIn,
  Min,
  Max,
} from 'class-validator';
import type { ArchiveFilters } from '@kingside/shared';

const VALID_RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];
const VALID_SORTS = ['recent', 'topElo', 'oldest'];

/**
 * DTO для PUT /api/user/preferences/archive-filters (KS-2210).
 *
 * Все поля опциональны. `null` — явный сброс фильтра
 * (убрать из сохранённых).
 */
export class ArchiveFiltersDto implements ArchiveFilters {
  @IsOptional()
  @IsString()
  player?: string | null;

  @IsOptional()
  @IsString()
  event?: string | null;

  @IsOptional()
  @IsString()
  eco?: string | null;

  @IsOptional()
  @IsIn(VALID_RESULTS)
  result?: string | null;

  @IsOptional()
  @IsString()
  timeControl?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(4000)
  minElo?: number | null;

  @IsOptional()
  @IsString()
  since?: string | null;

  @IsOptional()
  @IsString()
  until?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  minPly?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  maxPly?: number | null;

  @IsOptional()
  @IsIn(VALID_SORTS)
  sort?: string | null;
}
