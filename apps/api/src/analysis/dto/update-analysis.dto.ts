import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateAnalysisDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  pgn?: string;

  @IsOptional()
  @IsString()
  fen?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentPosition?: number | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @MaxLength(30, { each: true })
  tags?: string[];
}
