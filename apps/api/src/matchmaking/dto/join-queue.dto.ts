import { IsInt, IsOptional, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_INITIAL_TIME_SEC, MAX_INCREMENT_SEC } from '@kingside/shared';
import type { WsMatchmakingJoinPayload, RatingFilter } from '@kingside/shared';

export class RatingFilterDto implements RatingFilter {
  @IsOptional()
  @IsInt()
  @Min(0)
  minRating?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRating?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  ratingDelta?: number;
}

export class JoinQueueDto implements WsMatchmakingJoinPayload {
  @IsInt()
  @Min(1)
  @Max(MAX_INITIAL_TIME_SEC)
  timeInitial!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_INCREMENT_SEC)
  increment!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => RatingFilterDto)
  ratingFilter?: RatingFilterDto;
}
