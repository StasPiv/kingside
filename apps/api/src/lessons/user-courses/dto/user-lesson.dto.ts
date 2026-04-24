import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  CreateUserLessonRequest,
  ReorderUserLessonsRequest,
  UpdateUserLessonRequest,
} from '@kingside/shared';

/**
 * DTO для `POST /lessons/user-courses/:id/lessons` (ADR-026 §2.2).
 *
 * Длины и границы:
 *   - title: 1..120
 *   - estMinutes: 1..600 (10 часов — потолок; больше — это не один урок,
 *     а уже курс; ADR §2.2 не оговаривает жёстко, но 1..600 безопасный
 *     диапазон для slider-UI)
 */
export class CreateUserLessonDto implements CreateUserLessonRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  estMinutes?: number;
}

export class UpdateUserLessonDto implements UpdateUserLessonRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  estMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

/**
 * POST /lessons/user-courses/:id/lessons/reorder — массовый order-апдейт
 * уроков в одной транзакции (KS-1862). Сервис дополнительно проверяет,
 * что все id принадлежат курсу и список полный.
 */
export class ReorderUserLessonsDto implements ReorderUserLessonsRequest {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}
