import { IsInt, Max, Min } from 'class-validator';

/**
 * KS-3830 / ADR-116 §5.1. Тело запроса `POST /lectures/:id/audio/chunk-url`.
 *
 * `seq` — порядковый номер чанка (0..N). `sizeBytes` подписывается в
 * presigned URL'е через `Content-Length` — клиент обязан передать
 * именно столько байт, иначе подпись не сойдётся. Верхний потолок —
 * 16 МБ за чанк (с запасом против типичных 100–500 КБ на 5-секундный
 * chunk).
 */
export class ChunkUrlDto {
  @IsInt()
  @Min(0)
  @Max(100_000)
  seq!: number;

  @IsInt()
  @Min(1)
  @Max(16 * 1024 * 1024)
  sizeBytes!: number;
}
