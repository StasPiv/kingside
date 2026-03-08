import { IsIn, IsInt, IsString, Min } from 'class-validator';
import type { PuzzleAttemptRequest, PuzzleAttemptResult } from '@kingside/shared';

export class SubmitAttemptDto implements PuzzleAttemptRequest {
  @IsString()
  @IsIn(['solved', 'failed'])
  result!: PuzzleAttemptResult;

  @IsInt()
  @Min(0)
  timeMs!: number;
}
