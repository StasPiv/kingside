/**
 * KS-4759 / ADR-150 T1. DTO для `POST /test/seed/events`. Используется
 * только в test-mode (HINTS_TEST_MODE=1). На проде модуль не подключён,
 * этот файл компилируется но не маршрутизируется.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class TestActorDto {
  @IsIn(['user', 'guest'])
  type!: 'user' | 'guest';

  @IsString()
  @MinLength(1)
  id!: string;
}

export class TestSeedEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  type!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown> | null;

  /** ISO-8601 момент события. Записывается в `created_at` напрямую. */
  @IsISO8601()
  created_at!: string;
}

export class TestSeedEventsBodyDto {
  @ValidateNested()
  @Type(() => TestActorDto)
  actor!: TestActorDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => TestSeedEventDto)
  events!: TestSeedEventDto[];
}

export class TestCleanActorBodyDto {
  @ValidateNested()
  @Type(() => TestActorDto)
  actor!: TestActorDto;
}
