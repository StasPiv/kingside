import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * KS-2373: whitelist разделов для динамического MobileBottomBar.
 * Должен совпадать с фронтовым `MobileBottomBar.tsx` enum.
 *
 * Если фронт расширяет список — добавлять сюда. Любой неизвестный
 * route отвергается через class-validator.
 */
export const NAV_ROUTES = [
  'play',
  'tournaments',
  'workshop',
  'lessons',
  'drills',
  'broadcasts',
  'archive',
  'profile',
  'puzzles',
  // KS-2537 / ADR-048 §3 #1. Раздел «Тренировка точности».
  'precision',
] as const;

export type NavRoute = (typeof NAV_ROUTES)[number];

export class NavStatsIncrementDto {
  @IsIn(NAV_ROUTES)
  route!: NavRoute;
}

export class NavStatsTopQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
