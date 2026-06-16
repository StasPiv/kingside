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
  ArchiveBucket,
  ArchiveGameColor,
  ArchiveGameResult,
  ArchiveGamesByPositionRequest,
  ArchiveGamesSort,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSort[] = ['recent', 'topElo'];
const COLOR_VALUES: ArchiveGameColor[] = ['white', 'black', 'any'];
const TIME_CONTROL_CATEGORY_VALUES: ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

/**
 * Query validation for `GET /api/archive/games/by-position`.
 *
 * See {@link ArchiveGamesByPositionRequest} for the contract. `fen` is
 * required; remaining fields are filters / pagination knobs.
 */
export class ArchiveGamesByPositionQueryDto
  implements ArchiveGamesByPositionRequest
{
  @IsString()
  fen!: string;

  @IsOptional()
  @IsIn(['master', 'user'])
  bucket?: ArchiveBucket;

  @IsOptional()
  @IsIn(SORT_VALUES)
  sort?: ArchiveGamesSort;

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
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4000)
  minElo?: number;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsIn(RESULT_VALUES)
  result?: ArchiveGameResult;

  @IsOptional()
  @IsIn(COLOR_VALUES)
  color?: ArchiveGameColor;

  @IsOptional()
  @IsString()
  move?: string;

  @IsOptional()
  @IsString()
  player?: string;

  @IsOptional()
  @IsString()
  eco?: string;

  /**
   * KS-3468 (ADR-090 §4.1). Один или несколько time-control'ов
   * (`?timeControlCategory=classical&timeControlCategory=rapid` — Express
   * парсит дубликаты query как массив). Семантика — OR между элементами,
   * AND с остальными фильтрами.
   */
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TIME_CONTROL_CATEGORY_VALUES.length)
  @IsIn(TIME_CONTROL_CATEGORY_VALUES, { each: true })
  timeControlCategory?: ArchiveTimeControlCategory[];
}
