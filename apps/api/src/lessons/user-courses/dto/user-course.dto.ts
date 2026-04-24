import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
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
