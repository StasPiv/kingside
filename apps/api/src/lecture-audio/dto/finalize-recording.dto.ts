import {
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * KS-3830 / ADR-116 §5.1. Тело запроса `POST /lectures/:id/end` —
 * финализация клиентской записи лекции. Все поля опциональны: если
 * клиент закрыл вкладку без вызова end, эту же работу выполнит
 * cron-восстановитель (KS-3833), пересчитав offset из чанков.
 *
 * `offsetMs` — смещение начала аудио относительно
 * `Lecture.startedAt` (мс). Может быть отрицательным (recorder
 * стартовал раньше первого recorded-события).
 *
 * `chunkCount` — сколько чанков клиент успел залить. Финалайзер
 * сверяет с тем, что реально нашёл в `ListObjectsV2` — рассинхрон
 * логируется (warn), но не блокирует склейку.
 *
 * `recorderStartedAtClient`/`recorderEndedAtClient` — ISO-времена
 * `MediaRecorder.start()` / `.stop()` на клиенте (с учётом
 * клиентских часов; clock-skew компенсируется через `serverNow`
 * из start, см. KS-3834).
 */
export class FinalizeRecordingDto {
  @IsOptional()
  @IsInt()
  @Min(-3_600_000)
  @Max(86_400_000)
  offsetMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  chunkCount?: number;

  @IsOptional()
  @IsISO8601()
  recorderStartedAtClient?: string;

  @IsOptional()
  @IsISO8601()
  recorderEndedAtClient?: string;
}
