import {
  IsInt,
  IsISO8601,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * KS-3830 / ADR-116 §5.1. Тело запроса
 * `POST /lectures/:id/audio/chunk-ack` — подтверждение клиента, что
 * PUT чанка прошёл успешно. ETag и фактический размер — для
 * идемпотентного UPSERT по `(lectureId, seq)`.
 */
export class ChunkAckDto {
  @IsInt()
  @Min(0)
  @Max(100_000)
  seq!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  etag!: string;

  @IsInt()
  @Min(1)
  @Max(16 * 1024 * 1024)
  sizeBytes!: number;

  @IsISO8601()
  clientCreatedAt!: string;
}
