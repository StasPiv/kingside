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
  ArchiveGamesByPositionRequest,
  ArchiveGamesSort,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSort[] = ['recent', 'topElo'];
const COLOR_VALUES: ArchiveGameColor[] = ['white', 'black', 'any'];

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
}
