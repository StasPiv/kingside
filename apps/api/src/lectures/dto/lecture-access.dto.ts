import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

/**
 * KS-3936 / ADR-118 §2.4.1. Body для `POST /lectures/:id/access`
 * (owner-only). Тренер передаёт массив userId'ов, которым нужно
 * выдать доступ к restricted-лекции. Идемпотентно: дубли и уже
 * добавленные молча пропускаются, несуществующие — в `notFound`
 * ответа.
 *
 * Лимит `ArrayMaxSize(500)` — мягкая защита от случайной массовой
 * загрузки allowlist'а одним запросом (UI не предлагает столько).
 * При попытке передать больше — 400 Bad Request; фронт может бить
 * запрос на батчи.
 */
export class AddLectureAccessDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  userIds!: string[];
}
