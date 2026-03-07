import { IsEnum, IsInt, Min } from 'class-validator';
import { TimeControlType } from '../../generated/prisma/enums';

export class JoinQueueDto {
  @IsEnum(TimeControlType)
  timeControl!: TimeControlType;

  @IsInt()
  @Min(1)
  timeInitial!: number;

  @IsInt()
  @Min(0)
  increment!: number;
}
