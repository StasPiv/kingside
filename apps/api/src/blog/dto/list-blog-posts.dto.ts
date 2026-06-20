/**
 * KS-4409 / ADR-137 rev2. Query-DTO для `GET /blog/posts`.
 *   * `locale` обязателен — клиент знает свою локаль и передаёт явно
 *     (страница `/blog` не должна решать «и тут en, и тут ru»).
 *   * `page` 1-based, default 1.
 *   * `tag` опц. — фильтр по точному вхождению в массив `tags`.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { BlogLocale } from '@kingside/shared';

const LOCALES: BlogLocale[] = ['ru', 'en'];

export class ListBlogPostsDto {
  @IsIn(LOCALES)
  locale!: BlogLocale;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @IsString()
  tag?: string;
}
