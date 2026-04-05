import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSavedFilterDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['analysis', 'game_review', 'puzzle', ''])
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  tags?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(['newest', 'oldest', 'title_asc', 'title_desc', ''])
  sortOrder?: string;
}
