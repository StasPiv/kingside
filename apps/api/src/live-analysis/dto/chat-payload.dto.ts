import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * KS-4008 / ADR-121 §6. DTO для WS-событий чата лекции в namespace
 * `/live-analysis`.
 *
 * Длина text в DTO — 1..2000: верхняя граница больше, чем
 * `LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH=500`, чтобы перехватывать
 * мусорные payload'ы на ранней стадии (защита от DoS на класс-валидатор
 * и Prisma) и при этом отдать клиенту нормальный `chat:error
 * {code:'too_long'}` через сервис, а не `invalid-payload`. После trim
 * сервис проверяет финальные 500 codepoints (см.
 * LectureChatService.normalizeText).
 */

export class ChatSendPayloadDto {
  @IsUUID()
  lectureId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;
}

export class ChatDeletePayloadDto {
  @IsUUID()
  lectureId!: string;

  @IsUUID()
  messageId!: string;
}

export class ChatMutePayloadDto {
  @IsUUID()
  lectureId!: string;

  @IsUUID()
  userId!: string;
}
