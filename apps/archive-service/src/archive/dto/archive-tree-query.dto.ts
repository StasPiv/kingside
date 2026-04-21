import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { ArchiveBucket, ArchiveTreeRequest } from '@kingside/shared';

export class ArchiveTreeQueryDto implements ArchiveTreeRequest {
  @IsString()
  fen!: string;

  @IsOptional()
  @IsIn(['master', 'user'])
  bucket?: ArchiveBucket;

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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
