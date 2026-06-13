import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
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

  /**
   * KS-3141: legacy-поле cp-алгоритма (CP-разница PV1-PV2). После
   * перехода на WDL-метрики (KS-2584/ADR-050) поле не вычисляется
   * клиентским/серверным генератором — оставлено опциональным для
   * обратной совместимости со старыми клиентами. `@Min(0)` снят:
   * cp-разница может быть отрицательной (например для пазлов «упустил
   * перевес», где PV1 — выигрыш, PV2 — ничья, cp-разница ≤ 0). Хранится
   * в БД как `Int?`.
   */
  @IsOptional()
  @IsInt()
  gap?: number;

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

  /**
   * KS-4098 / KS-4096. Maia weak-choice метрика, посчитанная клиентским
   * генератором (та же формула `computeWeakChoiceProb`, что у сервера).
   * Сохраняется в `puzzles.maia_weak_choice_prob` — иначе клиентские
   * пазлы остаются с `null` и отсекаются maia-фильтром `/precision/next`.
   */
  @IsOptional()
  @IsNumber()
  maiaWeakChoiceProb?: number | null;

  @IsOptional()
  @IsInt()
  maiaMetricVersion?: number | null;

  @IsOptional()
  @IsInt()
  maiaTop1Elo?: number | null;
}

export class BatchPuzzlesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchPuzzleItemDto)
  puzzles!: BatchPuzzleItemDto[];
}
