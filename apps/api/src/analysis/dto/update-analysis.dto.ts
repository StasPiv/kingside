import { IsInt, IsOptional, IsString, Min } from 'class-validator';

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
}
