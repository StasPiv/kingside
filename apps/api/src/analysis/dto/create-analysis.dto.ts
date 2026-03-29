import { IsIn, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsString()
  @IsIn(['analysis', 'game_review', 'puzzle'])
  category?: string;
}
