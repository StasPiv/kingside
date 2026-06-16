/**
 * KS-4264 / ADR-129 §5.4 / ADR-128 §6.8.4. Сервис для блока
 * социального доказательства на гостевом лендинге.
 *
 * Кэш-стратегия:
 *  - Один Redis-ключ `cache:landing:stats` с TTL 60s, содержит весь
 *    объект ответа. Это держит число обращений к БД на гостевом
 *    лендинге < 1/мин (пик трафика гасится).
 *  - На любую ошибку Redis — fallback на прямое чтение из БД (не
 *    бросаем). На ошибку отдельного counter'а БД — возвращаем
 *    `null` в этом поле, остальные значения остаются.
 *
 * Источники:
 *  - `onlineNow` — `User.lastSeenAt >= now - 5min` + ботам, у
 *    которых нет lastSeenAt threshold, всегда `online` по семантике
 *    проекта (см. `PlayerService.getOnlinePlayers`).
 *  - `gamesInProgress` — `Game.status='active'` (как
 *    `LiveGameService.getLiveCount`).
 *  - `totalGames` — `prisma.game.count()`.
 *  - `totalPuzzlesSolved` — `prisma.puzzleAttempt.count({ solved: true })`.
 *  - `registeredUsers` — `prisma.user.count({ isBot:false, isSynthetic:false })`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const CACHE_KEY = 'cache:landing:stats';
const CACHE_TTL_SEC = 60;

/** Гостям бот всегда online (как в PlayerService). */
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export interface LandingStats {
  totalGames: number | null;
  totalPuzzlesSolved: number | null;
  registeredUsers: number | null;
  onlineNow: number | null;
  gamesInProgress: number | null;
}

@Injectable()
export class LandingService {
  private readonly logger = new Logger(LandingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getStats(): Promise<LandingStats> {
    // 1. Попытка взять кэш. Redis-fault — лог warn, идём в БД.
    try {
      const cached = await this.redis.get(CACHE_KEY);
      if (cached) {
        try {
          return JSON.parse(cached) as LandingStats;
        } catch (err) {
          this.logger.warn(
            `landing.stats cache parse failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `landing.stats redis.get failed: ${(err as Error).message}`,
      );
    }

    // 2. Кэш-промах или Redis недоступен → читаем из БД. Каждое
    //    поле читаем с собственным try/catch — если один counter
    //    упал, остальные всё равно вернутся.
    const stats = await this.fetchFromDb();

    // 3. Кладём в кэш. Ошибка Redis при set'е — игнорируем (лог).
    try {
      await this.redis.set(
        CACHE_KEY,
        JSON.stringify(stats),
        'EX',
        CACHE_TTL_SEC,
      );
    } catch (err) {
      this.logger.warn(
        `landing.stats redis.set failed: ${(err as Error).message}`,
      );
    }

    return stats;
  }

  private async fetchFromDb(): Promise<LandingStats> {
    const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);

    const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        this.logger.warn(
          `landing.stats ${label} failed: ${(err as Error).message}`,
        );
        return null;
      }
    };

    const [totalGames, totalPuzzlesSolved, registeredUsers, onlineNow, gamesInProgress] =
      await Promise.all([
        safe('totalGames', () => this.prisma.game.count()),
        safe('totalPuzzlesSolved', () =>
          this.prisma.puzzleAttempt.count({ where: { solved: true } }),
        ),
        safe('registeredUsers', () =>
          this.prisma.user.count({
            where: { isBot: false, isSynthetic: false, isHidden: false },
          }),
        ),
        safe('onlineNow', async () => {
          // Real users (lastSeen ≥ 5 min ago, не боты/синтетики)
          // + бот-аккаунты (всегда «online»).
          const [real, bots] = await Promise.all([
            this.prisma.user.count({
              where: {
                isBot: false,
                isSynthetic: false,
                isHidden: false,
                lastSeenAt: { gte: threshold },
              },
            }),
            this.prisma.user.count({
              where: { isBot: true, isHidden: false },
            }),
          ]);
          return real + bots;
        }),
        safe('gamesInProgress', () =>
          this.prisma.game.count({ where: { status: 'active' } }),
        ),
      ]);

    return {
      totalGames,
      totalPuzzlesSolved,
      registeredUsers,
      onlineNow,
      gamesInProgress,
    };
  }
}
