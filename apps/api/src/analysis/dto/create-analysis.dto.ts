import { IsOptional, IsString } from 'class-validator';

export class CreateAnalysisDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  pgn?: string;

  @IsOptional()
  @IsString()
  fen?: string;
}
