/**
 * KS-4471 / ADR-140 T5. DTO PATCH /blog/comments/:id.
 * Те же правила что и POST (длина 2..2000); 15-минутное окно
 * редактирования и проверка авторства — в сервисе.
 */
import { IsString, Length } from 'class-validator';

export class UpdateBlogCommentDto {
  @IsString()
  @Length(2, 2000)
  body!: string;
}
