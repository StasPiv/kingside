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
  ArchiveGamesRequest,
  ArchiveGamesSortMetadata,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSortMetadata[] = ['recent', 'topElo', 'oldest'];

export class ArchiveGamesQueryDto implements ArchiveGamesRequest {
  @IsOptional()
  @IsString()
  fen?: string;

  @IsOptional()
  @IsString()
  move?: string;

  @IsOptional()
  @IsString()
  white?: string;

  @IsOptional()
  @IsString()
  black?: string;

  /**
   * KS-2081: фильтр по игроку, поддерживает 1..N substring'ов.
   *
   * Express парсит `?player=A&player=B` как массив строк, а одиночное
   * `?player=A` — как строку. Здесь нормализуем оба варианта в массив,
   * чтобы downstream-логика (service / SQL builder) была однообразной.
   * Лимит 5 — защита от случайного дисбаланса (запросов с 5+ AND-ветками
   * не предусмотрено UX).
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  player?: string[];

  @IsOptional()
  @IsString()
  eco?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4000)
  minElo?: number;

  @IsOptional()
  @IsIn(RESULT_VALUES)
  result?: ArchiveGameResult;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @IsString()
  event?: string;

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
