/**
 * KS-4409 / ADR-137 rev2. Query-DTO для `GET /blog/posts/:slug`.
 * `locale` обязателен — clientLocale в API. Сервер пытается найти
 * пост в этой локали, если нет — fallback на другую с маркером
 * `isLocaleFallback=true` (ADR-137 rev2: лучше показать чужой язык,
 * чем 404 для пользователя, пришедшего по deep-link).
 */
import { IsIn } from 'class-validator';
import type { BlogLocale } from '@kingside/shared';

const LOCALES: BlogLocale[] = ['ru', 'en'];

export class GetBlogPostDto {
  @IsIn(LOCALES)
  locale!: BlogLocale;
}
