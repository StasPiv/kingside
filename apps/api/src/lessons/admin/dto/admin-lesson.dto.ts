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
} from 'class-validator';
import type { LessonKind } from '@kingside/shared';

/**
 * KS-1962/B-6 — DTO для admin-CRUD уроков
 * (`/lessons/admin/courses/:courseId/lessons`,
 * `/lessons/admin/lessons/:id`).
 *
 * Контракт §3.3:
 *  - `slug` — уникален в рамках курса (Prisma `@@unique([courseId, slug])`).
 *  - `kind` — фиксированный набор (см. `LessonKind` в shared).
 *  - inline-поля `title`, `summary` (KS-1964) — приоритет над `*Key`
 *    на стороне FE.
 */

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LESSON_KINDS: ReadonlyArray<LessonKind> = [
  'theory',
  'tactics_set',
  'endgame_set',
  'opening_line',
  'game_review',
  'quiz',
];

const BLOCK_KEY_REGEX = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export class CreateAdminLessonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(SLUG_REGEX, {
    message: 'slug must be kebab-case ([a-z0-9-]+)',
  })
  slug!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(BLOCK_KEY_REGEX, {
    message: 'blockKey must be lowercase alphanumeric with - or _ separators',
  })
  blockKey!: string;

  @IsString()
  @IsIn([...LESSON_KINDS])
  kind!: LessonKind;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  summaryKey!: string;

  // ─── Inline (KS-1964) ─────────────────────────────────────────────

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  // ─── Прочее ───────────────────────────────────────────────────────

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  estMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

/** Все поля optional. Slug и blockKey тоже допустимы — при условии валидности. */
export class UpdateAdminLessonDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(SLUG_REGEX)
  slug?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(BLOCK_KEY_REGEX)
  blockKey?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LESSON_KINDS])
  kind?: LessonKind;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  summaryKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  estMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

/**
 * Полный список id уроков курса в новом порядке. См. §3.5 — ids
 * должен покрывать ВСЕ уроки курса; `order` перезаписывается 0..N-1.
 */
export class ReorderAdminLessonsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
}
