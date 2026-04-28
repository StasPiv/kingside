import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type { ArchivePlayerSearchRequest } from '@kingside/shared';

/**
 * KS-2065 / ADR-033 §4.4 + §6.3.
 * GET /api/archive/players/search?q=<query>&limit=
 */
export class ArchivePlayersSearchQueryDto implements ArchivePlayerSearchRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
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
