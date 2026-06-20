/**
 * KS-4356 / ADR-136 §3.8. Query-DTO для `GET /tactic-puzzles/attempts`.
 * Все поля опциональны; пустой запрос возвращает первую страницу
 * истории текущего пользователя, отсортированную по `createdAt DESC`.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { TacticStopReason } from '@kingside/shared';

const STOP_REASONS: TacticStopReason[] = [
  'easy',
  'mate',
  'mistake',
  'timeout',
  'aborted',
];

export class ListTacticAttemptsDto {
  /** ISO-8601 нижняя граница `createdAt` (включительно). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** ISO-8601 верхняя граница `createdAt` (включительно). */
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(STOP_REASONS)
  stopReason?: TacticStopReason;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  solved?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ratingMax?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
