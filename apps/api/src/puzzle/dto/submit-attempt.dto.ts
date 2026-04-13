import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { PuzzleAttemptRequest, PuzzleAttemptResult } from '@kingside/shared';

export class SubmitAttemptDto implements PuzzleAttemptRequest {
  @IsIn(['solved', 'failed'])
  result!: PuzzleAttemptResult;

  @IsInt()
  @Min(0)
  timeMs!: number;

  @IsOptional()
  @IsString()
  userMoves?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  hintsUsed?: number;
}
