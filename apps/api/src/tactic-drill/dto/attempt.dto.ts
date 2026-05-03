import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AnswerDataDto } from './answer.dto';

export class AttemptRequestDto {
  @IsUUID()
  drillId!: string;

  @ValidateNested()
  @Type(() => AnswerDataDto)
  userAnswer!: AnswerDataDto;

  @IsInt()
  @Min(0)
  timeMs!: number;

  @IsIn(['drill', 'sprint', 'lessons-embed'])
  mode!: 'drill' | 'sprint' | 'lessons-embed';

  @IsOptional()
  @IsString()
  sessionId?: string;
}
