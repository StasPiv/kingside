import {
  IsInt,
  Min,
  Max,
  IsOptional,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_INITIAL_TIME_SEC, MAX_INCREMENT_SEC } from '@kingside/shared';
import type { WsMatchmakingJoinPayload } from '@kingside/shared';

export class RatingRangeDto {
  @IsIn(['absolute', 'relative'])
  mode!: 'absolute' | 'relative';

  /** absolute mode: minimum rating */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4000)
  min?: number;

  /** absolute mode: maximum rating */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4000)
  max?: number;

  /** relative mode: points below own rating (positive number) */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  below?: number;

  /** relative mode: points above own rating (positive number) */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  above?: number;
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
  @Type(() => RatingRangeDto)
  ratingRange?: RatingRangeDto;
}
