import { IsIn, IsNumber, IsString } from 'class-validator';
import type { PuzzleRushAnswerRequest, PuzzleRushStartRequest } from '@kingside/shared';

export class StartPuzzleRushDto implements PuzzleRushStartRequest {
  @IsNumber()
  @IsIn([180, 300])
  timeLimitSec!: 180 | 300;
}

export class SubmitPuzzleAnswerDto implements PuzzleRushAnswerRequest {
  @IsString()
  uci!: string;
}
