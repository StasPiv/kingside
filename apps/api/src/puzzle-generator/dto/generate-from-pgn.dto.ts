import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';

export class GenerateFromPgnDto {
  @IsString()
  pgn!: string;

  @IsOptional()
  @IsInt()
  @Min(800)
  @Max(3000)
  whiteRating?: number;

  @IsOptional()
  @IsInt()
  @Min(800)
  @Max(3000)
  blackRating?: number;
}
