import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * KS-3602 / ADR-100 §8.4. DTO для `POST /analyses/:id/duplicate-annotated`.
 *
 * Frontend (B, KS-3603) клиентски прогоняет Stockfish+Maia на оригинале,
 * собирает аннотированный PGN и шлёт его сюда. Backend создаёт (или
 * обновляет существующий) дубль с soft-ссылкой `originalAnalysisId`.
 *
 * Идемпотентность: повторный вызов на том же оригинале обновляет
 * существующий дубль (не плодит v2/v3). См. AnalysisService.duplicateAnnotated.
 */
export class DuplicateAnnotatedDto {
  /**
   * Авто-аннотированный PGN. Limit 100_000 символов — то же, что фронт
   * присылает в обычном CreateAnalysisDto (для жёсткого UB на размер
   * мы конкретного ограничения тогда не ставили, но здесь явно ставим,
   * чтобы случайно не положить request большим payload'ом).
   */
  @IsString()
  @MaxLength(100_000)
  pgn!: string;

  /**
   * Суффикс к title дубля. Если не передан — `(автоаннотация)`.
   * Используется ТОЛЬКО при создании нового дубля; при update существующего
   * title не трогаем (пользователь мог переименовать вручную).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  titleSuffix?: string;
}
