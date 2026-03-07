import { IsInt, Min } from 'class-validator';

export class JoinQueueDto {
  @IsInt()
  @Min(1)
  timeInitial!: number;

  @IsInt()
  @Min(0)
  increment!: number;
}
