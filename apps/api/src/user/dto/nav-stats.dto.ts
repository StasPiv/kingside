import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * KS-2373: исторический список разделов нижней панели. Старые клиенты
 * (PostV1) шлют именно эти ключи в `POST /user/nav-stats/increment`.
 * Все они продолжают приниматься без миграций.
 *
 * KS-2809 / ADR-058 §5.3, §6.4 T12: на чтении (`GET /top`) старые
 * ключи агрегируются в новые группы (см. `aggregateNavRoute` ниже).
 */
export const LEGACY_NAV_ROUTES = [
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
  // KS-2809 / ADR-058 T12. Исторически был в фронте, в whitelist
  // не попадал — теперь принимается (новые клиенты могут слать).
  'puzzle-rush',
] as const;

/**
 * KS-2809 / ADR-058 §5.3, §6.4 T12. Новые групповые ключи sidebar'а
 * (`train` / `learn` / `analyze`) + сквозные (`play` / `broadcasts` /
 * `profile`). Новый фронт MobileBottomBar (KS-2805/2806) шлёт сразу
 * группы, без миграции старых ключей. PostV2.
 */
export const GROUP_NAV_ROUTES = [
  'train',
  'learn',
  'analyze',
  'play',
  'broadcasts',
  'profile',
] as const;

/**
 * Whitelist для `POST /increment`: принимаем И старые ключи, И новые
 * групповые — клиенты разных версий сосуществуют. Дубликаты (`play`,
 * `broadcasts`, `profile` присутствуют в обоих списках) дедуплицируются.
 */
export const NAV_ROUTES = Array.from(
  new Set<string>([...LEGACY_NAV_ROUTES, ...GROUP_NAV_ROUTES]),
) as readonly string[];

export type LegacyNavRoute = (typeof LEGACY_NAV_ROUTES)[number];
export type GroupNavRoute = (typeof GROUP_NAV_ROUTES)[number];
export type NavRoute = LegacyNavRoute | GroupNavRoute;

/**
 * KS-2809 / ADR-058 §5.3 T12. Маппинг старых ключей в новые группы.
 * Используется в `getTop` для агрегации на чтении.
 *
 *   puzzles + drills + precision + puzzle-rush + train → train
 *   workshop + archive + analyze                       → analyze
 *   tournaments + play                                 → play
 *   lessons + learn                                    → learn
 *   broadcasts                                         → broadcasts
 *   profile                                            → profile
 *
 * Любой route, не покрытый whitelist'ом (например, удалённый раздел
 * в старых записях БД), возвращает `null` — он будет проигнорирован
 * при агрегации.
 */
export function aggregateNavRoute(route: string): GroupNavRoute | null {
  switch (route) {
    case 'puzzles':
    case 'drills':
    case 'precision':
    case 'puzzle-rush':
    case 'train':
      return 'train';
    case 'workshop':
    case 'archive':
    case 'analyze':
      return 'analyze';
    case 'tournaments':
    case 'play':
      return 'play';
    case 'lessons':
    case 'learn':
      return 'learn';
    case 'broadcasts':
      return 'broadcasts';
    case 'profile':
      return 'profile';
    default:
      return null;
  }
}

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
