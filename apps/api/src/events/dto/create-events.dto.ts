/**
 * KS-4695 / ADR-147 §2.2. DTO `POST /events`. Контракт зафиксирован
 * в T2 (frontend events-клиент, KS-4684, commit 73183b8):
 *
 *   { events: [{ type: string, payload?: object, ts: string-ISO }] }
 *
 * Жёсткие лимиты:
 *   - `events.length` ≤ 50 (соответствует MAX_BATCH фронта).
 *   - `type` 1..64 ASCII-safe (соответствует `actor_events.type
 *     VARCHAR(64)`).
 *   - `payload` — произвольный объект (не массив, не примитив), ≤8 KB
 *     в сериализованном виде (защита от мусорного payload, ADR-147 §6.1
 *     «namesake не лимит payload, но и не безгранично»).
 *   - `ts` — ISO 8601, парсится `new Date(...)` без NaN.
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const MAX_EVENTS_PER_BATCH = 50;
const MAX_PAYLOAD_BYTES = 8 * 1024;

export class EventBatchItemDto {
  /**
   * Тип события (`page_view`, `puzzle_solved`, `guest_landing_viewed` …).
   * Узкий whitelist символов — защита от опечатки и от инжекции в
   * partition pruning сценариях.
   */
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z][a-z0-9_]*$/i, {
    message: 'type must match /^[a-z][a-z0-9_]*$/i (1..64)',
  })
  type!: string;

  /** Опциональный объект с данными события. */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /** ISO-8601 timestamp с клиента. */
  @IsISO8601({ strict: true })
  ts!: string;
}

export class CreateEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENTS_PER_BATCH, {
    message: `events.length must be <= ${MAX_EVENTS_PER_BATCH}`,
  })
  @ValidateNested({ each: true })
  @Type(() => EventBatchItemDto)
  events!: EventBatchItemDto[];
}

/**
 * Дополнительная проверка размера payload в байтах — после парсинга
 * валидатором (class-validator не знает про byteLength).
 * Бросает с message, который контроллер вернёт как 422.
 */
export function assertPayloadSizes(dto: CreateEventsDto): void {
  for (const e of dto.events) {
    if (!e.payload) continue;
    const serialized = JSON.stringify(e.payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `event.payload too large (>${MAX_PAYLOAD_BYTES} bytes) for type=${e.type}`,
      );
    }
  }
}
