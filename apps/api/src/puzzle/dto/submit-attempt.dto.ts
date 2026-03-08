import { IsIn, IsInt, Min } from 'class-validator';
import type { PuzzleAttemptResult } from '@kingside/shared';

export class SubmitAttemptDto {
  @IsIn(['solved', 'failed'])
  result!: PuzzleAttemptResult;

  @IsInt()
  @Min(0)
  timeMs!: number;
}
