import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { ArchiveEventSearchRequest } from '@kingside/shared';

/** KS-2065. GET /api/archive/events/search */
export class ArchiveEventsSearchQueryDto implements ArchiveEventSearchRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  q!: string;

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
  offset?: number;
}
