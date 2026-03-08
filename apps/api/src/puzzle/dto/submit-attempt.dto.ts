import { IsBoolean, IsString } from 'class-validator';

export class SubmitAttemptDto {
  @IsString()
  puzzleId!: string;

  @IsBoolean()
  solved!: boolean;
}
