import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FindPuzzlesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Max(4000)
  ratingMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
