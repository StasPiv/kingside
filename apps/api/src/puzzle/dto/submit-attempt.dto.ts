<<<<<<< HEAD
import { IsBoolean, IsInt, Min } from 'class-validator';

export class SubmitAttemptDto {
  @IsBoolean()
  solved: boolean;

  @IsInt()
  @Min(0)
  timeMs: number;
=======
import { IsBoolean, IsString } from 'class-validator';

export class SubmitAttemptDto {
  @IsString()
  puzzleId!: string;

  @IsBoolean()
  solved!: boolean;
>>>>>>> feature/KS-140
}
