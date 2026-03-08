import { IsIn, IsString } from 'class-validator';

export class StartPuzzleRushDto {
  @IsIn(['3', '5'])
  timeMode!: '3' | '5';
}

export class SubmitPuzzleAnswerDto {
  @IsString()
  uci!: string;
}
