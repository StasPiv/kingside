/**
 * KS-4471 / ADR-140 T5. DTO POST /blog/posts/:id/comments.
 *
 * Длина 2..2000 валидируется class-validator'ом до входа в сервис.
 * Дополнительные правила (HTML-strip, лимит URL ≤ 2) — в сервисе,
 * после нормализации текста.
 */
import { IsString, Length } from 'class-validator';

export class CreateBlogCommentDto {
  @IsString()
  @Length(2, 2000)
  body!: string;
}
