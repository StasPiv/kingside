/**
 * KS-4356 / ADR-136 §3.8. Query-DTO для
 * `GET /tactic-puzzles/stats/rating-history`. Источник — таблица
 * `tactic_rating_snapshots` (T1 KS-4354). Дни без снимка пропускаем.
 */
import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export class RatingHistoryDto {
  /** ISO-8601 дата от (включительно). По умолчанию — без ограничения снизу. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** ISO-8601 дата до (включительно). По умолчанию — сегодня. */
  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Гранулярность точек. Пока поддерживается только `day`. */
  @IsOptional()
  @IsIn(['day'])
  granularity?: 'day';
}
