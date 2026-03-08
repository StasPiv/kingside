import { IsIn, IsInt, Min } from 'class-validator';

export class SubmitAttemptDto {
  @IsIn(['solved', 'failed'])
  result!: 'solved' | 'failed';

  @IsInt()
  @Min(0)
  timeMs!: number;
}
