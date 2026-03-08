import { IsIn, IsString } from 'class-validator';
import type { PuzzleRushAnswerRequest } from '@kingside/shared';

// NOTE: StartPuzzleRushDto uses timeMode: '3'|'5' while shared contract
// uses timeLimitSec: 180|300. Field mismatch — needs architect decision.
export class StartPuzzleRushDto {
  @IsIn(['3', '5'])
  timeMode!: '3' | '5';
}

export class SubmitPuzzleAnswerDto implements PuzzleRushAnswerRequest {
  @IsString()
  uci!: string;
}
