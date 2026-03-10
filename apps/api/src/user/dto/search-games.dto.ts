import { IsIn, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import type { SearchGamesQuery } from '@kingside/shared';

export class SearchGamesDto implements SearchGamesQuery {
  @IsOptional()
  @IsString()
  opponent?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  color?: 'white' | 'black';

  @IsOptional()
  @IsIn(['win', 'loss', 'draw'])
  result?: 'win' | 'loss' | 'draw';

  @IsOptional()
  @IsString()
  eco?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}
