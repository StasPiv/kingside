/**
 * KS-4410 / ADR-137 rev2 + KS-4446 / ADR-138 §7. DTO для админ-CRUD
 * блога. На public эндпоинтах эти типы недоступны — `BlogController`
 * использует только `ListBlogPostsDto` / `GetBlogPostDto`.
 *
 * Multipart-режим (KS-4445/KS-4446): текстовые поля в `multipart/form-
 * data` всегда приходят как строки, поэтому массивы, числа и булевы
 * нормализуются через `@Transform` (см. ниже `parseTagsArray`,
 * `parseBooleanFlag`). На чистом JSON-запросе значения уже типизированы
 * и `@Transform` проходит no-op.
 */
import { BadRequestException } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { BlogLocale, BlogPostStatus } from '@kingside/shared';

const LOCALES: BlogLocale[] = ['ru', 'en'];
const STATUSES: BlogPostStatus[] = ['draft', 'published'];

// ─── transformers (KS-4446) ─────────────────────────────────────────

/**
 * KS-4446 / ADR-138 §7. Парсер `tags` из multipart-строки.
 *   * чистый массив (JSON-режим) → пропускается без изменений;
 *   * пустая строка / `undefined` → `undefined` (поле не задано);
 *   * валидная JSON-строка массива → распарсенный массив;
 *   * невалидный JSON или JSON, не массив → `400 BadRequest`.
 *
 * Невалидный JSON ловится тут, а не в `@IsArray`, чтобы сообщение
 * было понятным («tags must be a JSON array string», а не «tags must
 * be an array»).
 */
export function parseTagsArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new BadRequestException(
      `tags must be a JSON array string (parse error: ${(err as Error).message})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException(
      `tags must be a JSON array; got ${typeof parsed}`,
    );
  }
  return parsed;
}

/**
 * KS-4446 / ADR-138 §7. Парсер булевых флагов из multipart-строк.
 * Единая семантика для всех булевых полей (`coverReset`, будущие
 * `isPinned`/`featured`/...) — наследуется от первой реализации в
 * KS-4445.
 */
export function parseBooleanFlag(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 'on') return true;
  if (
    value === 'false' ||
    value === '0' ||
    value === 'off' ||
    value === ''
  ) {
    return false;
  }
  return value;
}

// ─── posts ──────────────────────────────────────────────────────────

export class CreateBlogPostDto {
  /** kebab-case или дефис-разделённый, без пробелов и слэшей. */
  @IsString()
  @Length(1, 200)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug должен быть kebab-case: lowercase a-z, 0-9, разделитель «-»',
  })
  slug!: string;

  @IsIn(LOCALES)
  locale!: BlogLocale;

  @IsString()
  @Length(1, 300)
  title!: string;

  @IsString()
  @Length(1, 500)
  description!: string;

  @IsString()
  @MinLength(1)
  bodyMd!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  coverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverAlt?: string;

  @IsOptional()
  @Transform(({ value }) => parseTagsArray(value))
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  relatedRoute?: string;

  @IsUUID()
  authorId!: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: BlogPostStatus;

  /** ISO-8601. Если задан и `status='published'` — используется как
   *  момент публикации; иначе сервер выставит `now()` при переходе. */
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;
}

/**
 * Поля для PUT `/admin/blog/posts/:id`. Все опц.: PATCH-семантика
 * (отсутствие поля = «не меняй»). slug и locale меняются на свой
 * страх и риск — uniqueIndex `(slug, locale)` не даст коллизии.
 */
export class UpdateBlogPostDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: BlogLocale;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  bodyMd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  coverUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverAlt?: string | null;

  @IsOptional()
  @Transform(({ value }) => parseTagsArray(value))
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  relatedRoute?: string | null;

  @IsOptional()
  @IsUUID()
  authorId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: BlogPostStatus;

  @IsOptional()
  @IsISO8601()
  publishedAt?: string | null;

  /**
   * KS-4445 / ADR-138 §6. Многочастная семантика обнуления обложки:
   * `coverReset=true` (как boolean или строка) в теле PATCH обнуляет
   * `coverUrl` (и снимает её привязку с CDN). Если одновременно
   * пришёл файл `cover` — приоритет у файла, reset игнорируется.
   *
   * В JSON-режиме параметр тоже работает: фронт может слать
   * `{"coverReset": true}` без multipart.
   */
  @IsOptional()
  @Transform(({ value }) => parseBooleanFlag(value))
  @IsBoolean()
  coverReset?: boolean;
}

export class UpdateBlogPostStatusDto {
  @IsIn(STATUSES)
  status!: BlogPostStatus;
}

export class PreviewBlogMarkdownDto {
  @IsString()
  @MinLength(1)
  bodyMd!: string;
}

export class ListAdminBlogPostsDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: BlogPostStatus;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: BlogLocale;

  @IsOptional()
  @IsUUID()
  authorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;
}

// ─── authors ────────────────────────────────────────────────────────

export class CreateBlogAuthorDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  handle!: string;

  @IsString()
  @Length(1, 200)
  nameRu!: string;

  @IsString()
  @Length(1, 200)
  nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bioRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bioEn?: string;
}

export class UpdateBlogAuthorDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  handle?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameRu?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  avatarUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bioRu?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bioEn?: string | null;
}
