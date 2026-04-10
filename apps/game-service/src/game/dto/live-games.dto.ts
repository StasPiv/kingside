import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class LiveGamesDto {
  @IsOptional()
  @IsIn(['bullet', 'blitz', 'rapid', 'classical'])
  type?: 'bullet' | 'blitz' | 'rapid' | 'classical';

  @IsOptional()
  @IsString()
  player?: string;

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
