/**
 * KS-4342 / ADR-135 §2.4. Query-DTO для `GET /tactic-puzzles/browse`.
 * Все поля опциональны. Cursor — opaque base64-токен от прошлого
 * ответа; невалидный → начинаем с начала.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { TacticPuzzleBrowseQuery } from '@kingside/shared';

// KS-4369 / KS-4367. Поле `objective` и массив OBJECTIVES удалены —
// семантика «реализуй перевес / удержи равенство» уходит из всего раздела.

export class BrowseTacticPuzzlesDto implements TacticPuzzleBrowseQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  maiaDifficultyMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  gapMin?: number;

  // KS-4377 / KS-4375. `ratingMin`/`ratingMax` удалены вместе с
  // полем `rating` пазла. Сложность фильтруется через
  // `maiaDifficultyMin` / `gapMin`. Аналогичный фильтр по
  // пользовательскому рейтингу остаётся в `ListTacticAttemptsDto`
  // (другая сущность — пользовательский рейтинг).

  /** KS-4365. `?solved=true|false` — фильтр по факту успешной попытки
   *  текущего пользователя. Для гостя сервис игнорирует. */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  solved?: boolean;

  /** `?themes=a,b,c` — CSV; client может также отправить `?themes=a&themes=b`. */
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value.flatMap((v: unknown) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      );
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return undefined;
  })
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}
