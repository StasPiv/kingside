import { ArrayMinSize, IsArray, IsString } from 'class-validator';

export class PositionCommentDto {
  @IsString()
  fen!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  factors!: string[];
}
