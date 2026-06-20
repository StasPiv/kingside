/**
 * KS-4410 / ADR-137 rev2. DTO для админ-CRUD блога. На public
 * эндпоинтах эти типы недоступны — `BlogController` использует
 * только `ListBlogPostsDto` / `GetBlogPostDto`.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
