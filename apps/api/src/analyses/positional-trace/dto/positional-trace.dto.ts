import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { POSITIONAL_TRACE_VALUE_LIMIT } from '@kingside/shared';

/**
 * KS-4023 / ADR-122 §3. DTO для `POST /games/:gameId/positional-trace`.
 *
 * Размер тела (≤ 256 КБ) проверяется отдельно в обработчике до
 * запуска class-validator: на больших превышениях получить
 * полноценный `400 invalid_payload` через DTO — слишком дорого,
 * лучше быстрый `413 positional_trace_too_large`.
 *
 * Дополнительные сценарные проверки (монотонный `ply`, совпадение
 * `sfVersion` с серверной константой) живут в сервисе, потому что
 * требуют контекста (например, выяснить ожидаемую версию).
 */

/**
 * Одна запись `PositionalSubterm` в payload. Поля согласованы с
 * `PositionalSubterm` в `@kingside/shared/types/api-contracts`:
 *   - `id` — non-empty string ≤ 64 символов;
 *   - `square` — алгебраическая нотация `a1..h8`, опционально;
 *   - `color` — `'w' | 'b'`, опционально;
 *   - `value_mg`/`value_eg` — числа в диапазоне ±20 (см.
 *     `POSITIONAL_TRACE_VALUE_LIMIT`).
 */
export class PositionalSubtermInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-h][1-8]$/, {
    message: 'square must match /^[a-h][1-8]$/',
  })
  square?: string;

  @IsOptional()
  @IsIn(['w', 'b'])
  color?: 'w' | 'b';

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-POSITIONAL_TRACE_VALUE_LIMIT)
  @Max(POSITIONAL_TRACE_VALUE_LIMIT)
  value_mg!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-POSITIONAL_TRACE_VALUE_LIMIT)
  @Max(POSITIONAL_TRACE_VALUE_LIMIT)
  value_eg!: number;
}

/**
 * Один полуход в массиве `plies`. `ply` целое ≥ 0, `phase` — 0..256
 * (см. ADR-107 / `eval json`). Монотонность последовательности
 * `ply` проверяется в сервисе, а не валидатором — это не свойство
 * одиночного элемента.
 */
export class PositionalTracePlyDto {
  @IsInt()
  @Min(0)
  @Max(2000)
  ply!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PositionalSubtermInputDto)
  subterms!: PositionalSubtermInputDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(256)
  phase?: number;
}

export class PositionalTraceUpsertDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sfVersion!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PositionalTracePlyDto)
  plies!: PositionalTracePlyDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 60 * 1000) // до часа на расчёт — больше не имеет смысла
  durationMs?: number;
}

/**
 * Query-параметр для `GET /games/:gameId/positional-trace?v=<sfVersion>`.
 * Версия передаётся явно: фронт сверяется с серверной константой и
 * понимает «кеш протух → надо считать заново».
 */
export class PositionalTraceGetQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  v!: string;
}
