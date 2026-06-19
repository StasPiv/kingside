/**
 * KS-4342 / ADR-135 §2.4. DTO `POST /tactic-puzzles/:id/attempts`.
 * Структурно копирует `SubmitTacticAttemptInput` из shared, но с
 * class-validator декораторами для серверной валидации тела.
 */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type {
  SubmitTacticAttemptInput,
  TacticPuzzleStopReason,
} from '@kingside/shared';

const STOP_REASONS: TacticPuzzleStopReason[] = [
  'easy',
  'mate',
  'mistake',
  'timeout',
  'aborted',
];

export class SubmitTacticAttemptDto implements SubmitTacticAttemptInput {
  @IsInt()
  @Min(0)
  @Max(500)
  lineHalfMoves!: number;

  @IsString()
  userMoves!: string;

  @IsIn(STOP_REASONS)
  stopReason!: TacticPuzzleStopReason;

  @IsInt()
  @Min(0)
  @Max(60 * 60 * 1000) // <= 1 час
  timeMs!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  wdlStart?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  wdlEnd?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  movesAccuracy?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  precisionGrade?: number | null;

  /** Зарезервировано для будущей анти-чит-логики; backend сейчас сам
   *  выводит `solved` из `stopReason`. */
  @IsOptional()
  @IsBoolean()
  solvedHint?: boolean;
}
