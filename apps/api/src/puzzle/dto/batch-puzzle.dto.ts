import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  BatchPuzzleItem,
  PuzzleSolutionMode,
} from '@kingside/shared';

/**
 * KS-2580 (ADR-050 §3 #1). DTO для `POST /api/puzzles/batch`.
 *
 * Раньше batch hardcoded `isPublic=true` для всех записей и не
 * принимал `solutionMode` — это блокировало клиентский генератор
 * пазлов (KS-2584): пользователь хочет сохранить генерацию как
 * **draft** и опубликовать позже после ревью.
 *
 * Per-puzzle поля:
 *   - `isPublic?: boolean` — default `false` (draft). Backward-compat:
 *     ранее API возвращал public-пазлы; новые клиенты должны явно
 *     передавать `true` если хотят публикацию сразу.
 *   - `solutionMode?: 'forced-line' | 'play-vs-engine'` — default
 *     `'forced-line'` (тот же default, что у БД). Клиентский WDL-
 *     генератор будет передавать `'play-vs-engine'`.
 *
 * `moves` остаётся обязательной строкой, но допустима пустая (для
 * `play-vs-engine` сценария — `acceptedMoves`/`sourceMetadata`
 * описывают solution).
 */
/**
 * KS-2581: реализация shared-интерфейса `BatchPuzzleItem`. Поля и
 * семантика — там, здесь только class-validator декораторы для
 * NestJS ValidationPipe.
 */
export class BatchPuzzleItemDto implements BatchPuzzleItem {
  @IsString()
  fen!: string;

  @IsString()
  moves!: string;

  @IsInt()
  @Min(0)
  rating!: number;

  @IsInt()
  @Min(0)
  gap!: number;

  @IsString()
  themes!: string;

  @IsString()
  sourceType!: string;

  @IsOptional()
  @IsString()
  sourceId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sourceMoveNum?: number;

  @IsOptional()
  sourceMetadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  acceptedMoves?: string;

  /**
   * KS-2580: per-puzzle публикация. Default `false` (draft).
   */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /**
   * KS-2580: режим решения (ADR-044 §5.5). Default `'forced-line'`.
   */
  @IsOptional()
  @IsIn(['forced-line', 'play-vs-engine'])
  solutionMode?: PuzzleSolutionMode;
}

export class BatchPuzzlesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchPuzzleItemDto)
  puzzles!: BatchPuzzleItemDto[];
}
