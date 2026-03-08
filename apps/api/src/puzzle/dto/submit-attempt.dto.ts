import { IsBoolean, IsInt, Min } from 'class-validator';

export class SubmitAttemptDto {
  @IsBoolean()
  solved: boolean;

  @IsInt()
  @Min(0)
  timeMs: number;
}
