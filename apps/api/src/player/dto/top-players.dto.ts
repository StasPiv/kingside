import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { TopPlayersQuery, RatingType } from '@kingside/shared';

export class TopPlayersDto implements TopPlayersQuery {
  @IsOptional()
  @IsIn(['bullet', 'blitz', 'rapid', 'classical', 'puzzle'])
  type?: RatingType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
