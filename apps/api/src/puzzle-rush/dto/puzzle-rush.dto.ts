import { IsIn, IsString } from 'class-validator';
import type { PuzzleRushAnswerRequest, PuzzleRushStartRequest } from '@kingside/shared';

export class StartPuzzleRushDto implements PuzzleRushStartRequest {
  @IsString()
  @IsIn(['3', '5'])
  timeMode!: '3' | '5';
}

export class SubmitPuzzleAnswerDto implements PuzzleRushAnswerRequest {
  @IsString()
  uci!: string;
}
