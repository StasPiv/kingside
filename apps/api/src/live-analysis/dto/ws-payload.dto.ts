import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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

/**
 * KS-3744 / ADR-111 §2.2, §2.3. Payload события `state-patch` —
 * автор шлёт обновлённый annotated PGN + опц. headers/currentPly/
 * orientation. Валидация:
 *   - `pgn` — обязательная строка длиной ≤ 256 KB (262 144 байт).
 *     `MaxLength` отбрасывает чрезмерные payload-ы ещё до handler'а
 *     (gateway получит `invalid-payload`-event), что разгружает
 *     mutex per-slug в сервисе.
 *   - `headers` — опциональный `Record<string,string>`. Глубокую
 *     проверку типов значений делает сервис (для нестандартных
 *     значений просто игнорирует), здесь — только sanity.
 *   - `currentPly` — целое ≥ 0; верхняя граница (≤ длине истории)
 *     проверяется уже в сервисе.
 *   - `orientation` — `'white' | 'black'`.
 *
 * Hard cap на длину строки JSON-сообщения дополнительно ограничен
 * на уровне socket.io `maxHttpBufferSize` (512 KB, см. gateway-options).
 */
export class StatePatchPayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  slug!: string;

  @IsString()
  /**
   * 262 144 байт = 256 KB. Гейтвей при превышении возвращает
   * `error { code: 'pgn-too-large' }`. Класс-валидатор сообщает
   * стандартной ошибкой `MaxLength` — мапим в этот код в гейтвее
   * по фразе `pgn` в message.
   */
  @MaxLength(262_144)
  pgn!: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentPly?: number;

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';
}
