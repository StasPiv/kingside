import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * KS-3732 / ADR-110 §2.2. DTO для WS-событий namespace `/live-analysis`.
 *
 * Валидация через `class-validator` в гейтвее: невалидный payload →
 * `live-analysis:error { code: 'invalid-payload' }`. UCI-формат
 * `[a-h][1-8][a-h][1-8][qrbn]?` — 4–5 ASCII-символов; легальность
 * хода в текущем FEN проверяет уже сервис через `chess.js`.
 */

export class SubscribePayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;
}

export class UnsubscribePayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;
}

export class MovePayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;

  @IsString()
  @Matches(/^[a-h][1-8][a-h][1-8][qrbn]?$/, {
    message: 'uci must match /^[a-h][1-8][a-h][1-8][qrbn]?$/',
  })
  uci!: string;
}

export class ResetPayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fen?: string;

  /** PGN тут НЕ парсится сервером — клиент пришлёт уже либо FEN, либо
   * пусто. Поле оставлено для совместимости с контрактом из ADR §2.2. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  pgn?: string;
}

export class ClosePayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;
}

export class SyncRequestPayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;
}
