/**
 * KS-4471 / ADR-140 T5. Query GET /blog/posts/:id/comments.
 *
 * - `cursor` — opaque base64-строка от предыдущей страницы; на первом
 *   запросе не передаётся.
 * - `limit` — 1..50. По умолчанию 20.
 */
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListBlogCommentsDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
