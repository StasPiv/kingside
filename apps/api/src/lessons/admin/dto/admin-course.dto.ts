import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { CourseLevel } from '@kingside/shared';

/**
 * KS-1962/B-5: DTO для `/lessons/admin/courses`.
 *
 * Контракт зеркальный с публичным `Course`, но с расщеплением:
 *  - админ передаёт строкой inline-поля (`title`, `description`,
 *    `audience`, `hook`, `outcome`, `summary` — последнее на уровне
 *    урока, см. admin-lesson.dto.ts);
 *  - i18n-ключи (`titleKey`, `descriptionKey`, `audience/hook/
 *    outcomeI18nKey`) сохраняются для совместимости с seed'ом.
 *
 * Slug валидируется regex'ом: kebab-case, без двойных дефисов и без
 * trailing `-`. Это требование §3.2 концепта KS-1962.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const COURSE_LEVELS: ReadonlyArray<CourseLevel> = [
  'beginner',
  'intermediate',
  'advanced',
];

export class CreateAdminCourseDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(SLUG_REGEX, {
    message: 'slug must be kebab-case ([a-z0-9-]+, no leading/trailing dash, no --)',
  })
  slug!: string;

  @IsString()
  @IsIn([...COURSE_LEVELS])
  level!: CourseLevel;

  // ─── i18n keys (legacy, fallback на FE) ───────────────────────────

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  descriptionKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  audienceI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  hookI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outcomeI18nKey?: string | null;

  // ─── Inline fields (KS-1964) — приоритет над i18n на FE ──────────

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  audience?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hook?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  outcome?: string | null;

  // ─── Карточные поля ────────────────────────────────────────────

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  difficulty?: 1 | 2 | 3;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  estimatedMinutes?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

/**
 * Все поля optional. `slug` менять можно — UserCourseProgress привязан
 * к id, не к slug, но публичные ссылки могут устареть (см. §3.2).
 */
export class UpdateAdminCourseDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(SLUG_REGEX)
  slug?: string;

  @IsOptional()
  @IsString()
  @IsIn([...COURSE_LEVELS])
  level?: CourseLevel;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  descriptionKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  audienceI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  hookI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outcomeI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  audience?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hook?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  outcome?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  difficulty?: 1 | 2 | 3;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  estimatedMinutes?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

/**
 * Полный список id курсов в новом порядке. Сервис перезаписывает
 * `order` по индексу (1..N). Если набор не покрывает все существующие
 * курсы — 400 (см. §3.5 концепта).
 */
export class ReorderAdminCoursesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
}

/** GET /lessons/admin/courses — фильтры query. */
export class ListAdminCoursesQueryDto {
  @IsOptional()
  @IsString()
  @IsIn([...COURSE_LEVELS])
  level?: CourseLevel;

  /**
   * Параметр `?published=true|false|1|0`. Сериализатор query-string'и
   * отдаёт строку — нормализуем через `@Transform`. Любое не-bool
   * значение → undefined (фильтр не применяется).
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    return undefined;
  })
  @IsBoolean()
  published?: boolean;
}
