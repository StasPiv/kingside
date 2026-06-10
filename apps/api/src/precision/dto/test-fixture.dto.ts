/**
 * KS-3029. DTO для dev-only `POST /precision/attempts/_test_fixture`.
 *
 * Намеренно без `@ValidateNested` и без жёсткой валидации содержимого
 * — фронт e2e (KS-3007) шлёт синтетические WDL под контрольные кейсы
 * ADR-065 §4.3 / ADR-066 §5. Доверяем тесту, валидация на проде не
 * нужна (endpoint защищён `DevOnlyGuard`).
 */
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class TestFixtureWdlDto {
  @IsNumber()
  w!: number;
  @IsNumber()
  d!: number;
  @IsNumber()
  l!: number;
}

export class TestFixtureMoveDto {
  @IsNumber()
  ply!: number;

  @IsOptional()
  @IsString()
  fenBefore?: string;

  @IsString()
  playedUci!: string;

  @IsString()
  bestUci!: string;

  @IsOptional()
  @IsObject()
  wdlBefore?: { w: number; d: number; l: number } | null;

  @IsOptional()
  @IsObject()
  wdlAfter?: { w: number; d: number; l: number } | null;

  @IsOptional()
  @IsNumber()
  depth?: number | null;
}

export class CreateTestFixtureAttemptDto {
  @IsArray()
  moves!: TestFixtureMoveDto[];

  /**
   * Если не указан — сервис подберёт первый PVE-пазл в БД
   * (`solutionMode='play-vs-engine'`). Для e2e под конкретный
   * сценарий любой puzzleId годится — генератор за рамками теста.
   */
  @IsOptional()
  @IsString()
  puzzleId?: string;

  /**
   * end-reason для precision-snapshot. Default 'win' (для 5★ сценария)
   * или 'lose-wdl' (для 1★/2★). Не влияет на score, но пишется в БД.
   */
  @IsOptional()
  @IsIn([
    'win',
    'win-mate',
    'win-engine-resign',
    'lose-wdl',
    'lose-mate',
    'timeout',
    'aborted',
  ])
  endReason?: string;

  @IsOptional()
  @IsBoolean()
  solved?: boolean;
}
