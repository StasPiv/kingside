import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  PlayVsEnginePuzzleReason,
  PrecisionMoveSnapshot,
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

/**
 * KS-2717 / ADR-056 §3.3. Тройка W/D/L per-mille (как отдаёт
 * Stockfish с UCI_ShowWDL).
 */
export class WdlTripleDto {
  @IsInt()
  @Min(0)
  @Max(1000)
  w!: number;

  @IsInt()
  @Min(0)
  @Max(1000)
  d!: number;

  @IsInt()
  @Min(0)
  @Max(1000)
  l!: number;
}

/**
 * KS-2717 / ADR-056 §3.3. Снимок одного полухода игрока в PVE-attempt.
 * Серверная валидация (legality, classification) внутри сервиса —
 * клиентский `classification` если придёт, не используется.
 */
export class PrecisionMoveSnapshotDto implements PrecisionMoveSnapshot {
  @IsInt()
  @Min(1)
  @Max(1000)
  ply!: number;

  @IsString()
  fenBefore!: string;

  @IsString()
  playedUci!: string;

  @IsString()
  bestUci!: string;

  /**
   * KS-2754. UCI ответного хода движка на user-ход. Опционально:
   * `null`/пропуск — последний user-полуход партии (мат, пат, abort).
   */
  @IsOptional()
  @IsString()
  engineUci?: string | null;

  @IsOptional()
  @IsInt()
  cpBefore?: number | null;

  @IsOptional()
  @IsInt()
  cpAfter?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => WdlTripleDto)
  wdlBefore?: { w: number; d: number; l: number } | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => WdlTripleDto)
  wdlAfter?: { w: number; d: number; l: number } | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  depth?: number | null;
}

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
  @IsNumber()
  @Min(-1)
  @Max(1)
  initialWdl?: number;

  @IsOptional()
  @IsIn(PLAY_VS_ENGINE_REASONS)
  reason?: PlayVsEnginePuzzleReason;

  // ── KS-2717 / ADR-056 §3.3. Per-move snapshot для PVE-attempts ───
  // Игнорируется для forced-line; для PVE — сервер валидирует длину,
  // legality каждого хода через chess.js, и пересчитывает
  // classification из (cpBefore, cpAfter) сам — клиентскому полю
  // не верим (server-trust).

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PrecisionMoveSnapshotDto)
  moves?: PrecisionMoveSnapshotDto[];
}
