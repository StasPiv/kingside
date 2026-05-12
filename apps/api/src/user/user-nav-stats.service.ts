import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  aggregateNavRoute,
  type GroupNavRoute,
  type NavRoute,
} from './dto/nav-stats.dto';

/**
 * KS-2373: статистика посещений разделов для динамического
 * MobileBottomBar. Топ-3 (по умолчанию) маршрутов отображаются
 * в нижней панели мобильной версии, остальные — через меню «Ещё».
 *
 * Хранится на сервере в таблице `user_nav_stats(user_id, route, count)`,
 * UPSERT при инкременте, индекс `(user_id, count desc)` для быстрого
 * top-N запроса.
 *
 * Защита от спама — backend-side cooldown: повторный инкремент того
 * же `(user, route)` в течение `INCREMENT_COOLDOWN_SEC` секунд
 * игнорируется (no-op). Фронт делает свой debounce; этот cooldown —
 * вторая линия защиты.
 */

const INCREMENT_COOLDOWN_SEC = parseInt(
  process.env.NAV_STATS_INCREMENT_COOLDOWN_SEC ?? '5',
  10,
);

export interface NavStatsTopItem {
  route: string;
  count: number;
}

@Injectable()
export class UserNavStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * UPSERT: создать запись с count=1 либо инкрементировать существующую.
   * Cooldown: если existing.updated_at был < N секунд назад, no-op
   * (защита от race-condition / клиентского спама).
   */
  async increment(userId: string, route: NavRoute): Promise<void> {
    const cutoff = new Date(Date.now() - INCREMENT_COOLDOWN_SEC * 1000);

    // UPSERT с cooldown: count и updated_at обновляются только если
    // updated_at был ДО cutoff. Иначе — no-op (CASE проверка).
    // ON CONFLICT обновляет с защитой через WHERE.
    // updatedAt в Prisma model имеет @updatedAt — но raw SQL обходит
    // его, поэтому явно обновляем NOW().
    await this.prisma.$queryRawUnsafe(
      `INSERT INTO user_nav_stats (user_id, route, count, updated_at)
         VALUES ($1::uuid, $2, 1, NOW())
       ON CONFLICT (user_id, route) DO UPDATE
         SET count = user_nav_stats.count + 1,
             updated_at = NOW()
       WHERE user_nav_stats.updated_at < $3::timestamp`,
      userId,
      route,
      cutoff.toISOString(),
    );
  }

  /**
   * Top-N маршрутов пользователя по убыванию счётчика. По умолчанию 3.
   *
   * KS-2809 / ADR-058 §5.3, §6.4 T12: на чтении агрегируем legacy-ключи
   * (`puzzles`, `drills`, `precision`, `puzzle-rush`, `workshop`,
   * `archive`, `tournaments`, `lessons`) в новые группы (`train`,
   * `analyze`, `play`, `learn`). Группа `broadcasts` / `profile`
   * остаётся как есть. Это позволяет фронту KS-2805/2806 (MobileBottomBar)
   * получать ровно групповой набор, не зная истории.
   *
   * Агрегация — в JS, не в SQL: на пользователя приходится ≤ 14 строк
   * (число ключей в whitelist), оверхед нулевой, юнит-тест проще.
   *
   * `userNavStat` берём ВСЕ строки (limit применяется уже после
   * агрегации) — иначе SQL-`take=3` отрежет данные ДО суммирования и
   * группа `train` получит неполный count'ы (сценарий: 4 legacy-ключа
   * с одинаковыми небольшими счётчиками).
   */
  async getTop(userId: string, limit = 3): Promise<NavStatsTopItem[]> {
    const rows = await this.prisma.userNavStat.findMany({
      where: { userId },
      orderBy: { count: 'desc' },
      select: { route: true, count: true },
    });
    return aggregateNavStats(rows, limit);
  }
}

/**
 * KS-2809 / ADR-058 §5.3 T12. Чистая агрегация для unit-тестов.
 * Принимает плоский список `{route, count}` из БД, возвращает
 * top-N по убыванию count'а в групповых ключах.
 *
 * Сортировка стабильна по убыванию count, при равных count'ах
 * — по алфавиту route'а (детерминированный порядок для тестов
 * и для UI-консистентности между запросами).
 */
export function aggregateNavStats(
  rows: ReadonlyArray<{ route: string; count: number }>,
  limit = 3,
): NavStatsTopItem[] {
  const sums = new Map<GroupNavRoute, number>();
  for (const row of rows) {
    const group = aggregateNavRoute(row.route);
    if (!group) continue;
    sums.set(group, (sums.get(group) ?? 0) + row.count);
  }
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  return Array.from(sums.entries())
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
    .slice(0, safeLimit);
}
