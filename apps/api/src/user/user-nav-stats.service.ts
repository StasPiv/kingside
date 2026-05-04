import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NavRoute } from './dto/nav-stats.dto';

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
   */
  async getTop(userId: string, limit = 3): Promise<NavStatsTopItem[]> {
    const rows = await this.prisma.userNavStat.findMany({
      where: { userId },
      orderBy: { count: 'desc' },
      take: Math.min(Math.max(limit, 1), 20),
      select: { route: true, count: true },
    });
    return rows;
  }
}
