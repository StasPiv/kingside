import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type {
  PlayVsEnginePuzzleReason,
  PuzzleAttemptRequest,
  PuzzleAttemptResult,
} from '@kingside/shared';

const PLAY_VS_ENGINE_REASONS: PlayVsEnginePuzzleReason[] = [
  'win',
  'win-mate',
  'win-engine-resign',
  'lose-wdl',
  'lose-mate',
];

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

  // ── KS-2465 / ADR-044 §5.4. Поля play-vs-engine (опц.) ───────────
  // На MVP сервер только логирует, в БД не пишет (PuzzleAttempt.metadata
  // JSONB — v2). См. описание в `PuzzleAttemptRequest`.

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  halfMovesPlayed?: number;

  @IsOptional()
  @IsNumber()
  @Min(-1)
  @Max(1)
  finalWdl?: number;

  @IsOptional()
  @IsIn(PLAY_VS_ENGINE_REASONS)
  reason?: PlayVsEnginePuzzleReason;
}
