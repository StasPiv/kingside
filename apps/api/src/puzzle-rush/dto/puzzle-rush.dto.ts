import { IsIn, IsString } from 'class-validator';

export class StartPuzzleRushDto {
  @IsIn([180, 300])
  timeLimitSec!: 180 | 300;
}

export class SubmitPuzzleAnswerDto {
  @IsString()
  uci!: string;
}
