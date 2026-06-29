/**
 * KS-4799 / ADR-152 §2.1. DTO для query `GET /me/events`.
 *
 *   - `cursor`  — opaque base64 (JSON `{ createdAtIso, id }`); пустой
 *                 cursor = первая страница (от now()).
 *   - `limit`   — 1..100, default 50. Hard cap чтобы не отдать heap'у.
 *   - `types`   — comma-list, валидируется той же грамматикой, что и в
 *                 `create-events.dto.ts` (`^[a-z][a-z0-9_]*$`, ≤64).
 *                 Пустой/отсутствует → все типы.
 *   - `showSystem` — bool, default `false`. При `false` всегда (даже
 *                 если `types` содержит системный) отрезаются
 *                 `SYSTEM_EVENT_TYPES` из `@kingside/shared`.
 *
 * Все поля приходят как строки в query — class-transformer
 * `@Transform` приводит их к нативным типам ДО валидации (см. global
 * ValidationPipe c `transform: true`).
 */
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const EVENT_TYPE_REGEX = /^[a-z][a-z0-9_]*$/i;
const MAX_TYPE_LEN = 64;
const MAX_TYPES_IN_FILTER = 32;

export class ListEventsQueryDto {
  /** Opaque token предыдущей страницы. Парсится сервисом. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return value;
  })
  @IsString()
  @Length(1, 256)
  cursor?: string;

  /** Размер страницы. 1..100 (cap из ADR §2.1). */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : value;
  })
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Comma-list типов. После трансформации — массив строк, каждая
   * валидируется грамматикой. Защищает БД от мусорных значений в
   * query даже до Prisma.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '' || value === null) return undefined;
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  })
  @IsArray()
  @IsString({ each: true })
  @Length(1, MAX_TYPE_LEN, { each: true })
  @Matches(EVENT_TYPE_REGEX, { each: true })
  types?: string[];

  /**
   * Boolean из строки. Принимаем только литералы `'true'` / `'false'`
   * (Nest/class-validator `@IsBooleanString` слишком либеральный).
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === false) return value;
    const s = String(value).toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return value;
  })
  @IsBoolean()
  showSystem?: boolean;
}

export { MAX_TYPES_IN_FILTER };
