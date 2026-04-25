import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  CreateUserCourseRequest,
  UpdateUserCourseRequest,
} from '@kingside/shared';

/**
 * DTO для `POST /lessons/user-courses` (ADR-026 §2.2, KS-1830).
 *
 * Лимиты длины согласно §2.2:
 *   - title: 1..120 символов
 *   - description: 0..1000
 *   - slug (если явно передан): валидируется `SlugService.validateExplicit`
 *     в сервисе, не здесь — правила (минимум 3 символа, `[a-z0-9-]+`,
 *     без `--`, без trailing `-`) класс-валидатором не описать коротко.
 */
export class CreateUserCourseDto implements CreateUserCourseRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsString()
  slug?: string;
}

export class UpdateUserCourseDto implements UpdateUserCourseRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  /**
   * `description` допускаем `null`, чтобы клиент мог явно очистить поле
   * PATCH-запросом. `class-validator` по умолчанию не пропускает null —
   * делаем `@IsOptional()` и не ставим `@IsString()` строго (см.
   * правила ниже: если пришла строка — MaxLength сработает, если null —
   * пропускаем).
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

/**
 * KS-1918 / ADR-030 §2.1: query-параметры для `GET /lessons/user-courses`.
 * Используются и для `mine=1` (для будущей пагинации в редакторе), и
 * для `mine=0` (лента публичных курсов на лобби).
 *
 * Дефолты: `limit=50, offset=0` — то же поведение, что было до
 * KS-1918 (когда параметров не было). Существующие тесты на `mine=0`
 * без query'ев должны остаться зелёными.
 */
export class ListUserCoursesQueryDto {
  @IsOptional()
  @IsString()
  mine?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  offset?: number;
}

/**
 * KS-1918 / ADR-030 §3.2: query для
 * `GET /lessons/user-courses/authors`.
 */
export class ListCourseAuthorsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  offset?: number;

  /**
   * `'courses'` — `publicCoursesCount DESC, lastCourseUpdatedAt DESC`
   *   (продуктивные авторы первыми, при равенстве — недавно активные).
   * `'recent'`  — `lastCourseUpdatedAt DESC` (только по дате).
   */
  @IsOptional()
  @IsIn(['courses', 'recent'])
  sort?: 'courses' | 'recent';
}
