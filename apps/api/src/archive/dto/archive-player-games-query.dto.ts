import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type {
  ArchiveGameResult,
  ArchiveGamesSortMetadata,
  ArchivePlayerGamesRequest,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSortMetadata[] = ['recent', 'topElo', 'oldest'];
const COLOR_VALUES: Array<'white' | 'black' | 'any'> = ['white', 'black', 'any'];
const TIME_CONTROL_CATEGORY_VALUES: ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

/**
 * KS-2065. GET /api/archive/players/:slug/games?...
 *
 * Фильтры повторяют `ArchiveGamesQueryDto` (B1) и расширяются `color`
 * (сторона игрока в партии). `slug` приходит path-параметром,
 * проставляется сервисом, в DTO query не входит.
 */
export class ArchivePlayerGamesQueryDto implements Omit<ArchivePlayerGamesRequest, 'slug'> {
  @IsOptional()
  @IsIn(COLOR_VALUES)
  color?: 'white' | 'black' | 'any';

  @IsOptional()
  @IsIn(RESULT_VALUES)
  result?: ArchiveGameResult;

  @IsOptional()
  @IsString()
  eco?: string;

  @IsOptional()
  @IsString()
  event?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4000)
  minElo?: number;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  minPly?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  maxPly?: number;

  /**
   * KS-2118: фильтр по категории контроля времени.
   * Формат идентичен `ArchiveGamesQueryDto.timeControlCategory`.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsIn(TIME_CONTROL_CATEGORY_VALUES, { each: true })
  timeControlCategory?: ArchiveTimeControlCategory[];

  @IsOptional()
  @IsIn(SORT_VALUES)
  sort?: ArchiveGamesSortMetadata;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
