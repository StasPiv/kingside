import { IsString, IsInt, IsOptional, Min, Max, MaxLength } from 'class-validator';
import type { CreateTimeControlRequest } from '@kingside/shared';

export class CreateTimeControlDto implements CreateTimeControlRequest {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsInt()
  @Min(1)
  @Max(10800)
  initialSec!: number;

  @IsInt()
  @Min(0)
  @Max(600)
  incrementSec!: number;
}
