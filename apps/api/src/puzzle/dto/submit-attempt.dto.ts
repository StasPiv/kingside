import { IsIn, IsInt, IsString, Min } from 'class-validator';

export class SubmitAttemptDto {
  @IsString()
  @IsIn(['solved', 'failed'])
  result!: 'solved' | 'failed';

  @IsInt()
  @Min(0)
  timeMs!: number;
}
