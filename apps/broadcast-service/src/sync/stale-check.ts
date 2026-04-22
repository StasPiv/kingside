/**
 * KS-1700 Part A — чистая функция stale-check (без привязки к классу и
 * TCP-коннектам).
 *
 * Перенос из `apps/broadcast-worker/src/worker.ts` (ADR-022 §2.6 шаг 0).
 * Логика 1-в-1, изменений в поведении нет.
 *
 * Для каждого `isActive=true` broadcast:
 *  - если он в `currentLichessIds` — счётчик сбрасывается.
 *  - иначе — инкремент. На первом инкременте ставим TTL.
 *  - если счётчик достиг `staleCycles` — `isActive=false` и счётчик удаляется.
 *
 * Ошибки Redis/Prisma логируются но не прерывают обход (один сломанный
 * broadcast не должен ломать весь цикл).
 */

export interface StaleCheckPrisma {
  broadcast: {
    findMany(args: {
      where: { isActive: boolean };
      select: { id: boolean; lichessId: boolean; title: boolean };
    }): Promise<Array<{ id: string; lichessId: string; title: string }>>;
    update(args: {
      where: { id: string };
      data: { isActive: boolean };
    }): Promise<unknown>;
  };
}

export interface StaleCheckRedis {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number | 'OK'>;
  del(key: string): Promise<number>;
}

export interface StaleCheckLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface StaleCheckResult {
  marked: number;
  incremented: number;
  reset: number;
  scanned: number;
}

export async function runStaleCheck(opts: {
  prisma: StaleCheckPrisma;
  redis: StaleCheckRedis;
  currentLichessIds: Set<string>;
  staleCycles: number;
  ttlSeconds: number;
  keyPrefix: string;
  logger: StaleCheckLogger;
}): Promise<StaleCheckResult> {
  const {
    prisma,
    redis,
    currentLichessIds,
    staleCycles,
    ttlSeconds,
    keyPrefix,
    logger,
  } = opts;
  const result: StaleCheckResult = {
    marked: 0,
    incremented: 0,
    reset: 0,
    scanned: 0,
  };

  const active = await prisma.broadcast.findMany({
    where: { isActive: true },
    select: { id: true, lichessId: true, title: true },
  });
  result.scanned = active.length;

  for (const bc of active) {
    const key = `${keyPrefix}${bc.lichessId}`;

    if (currentLichessIds.has(bc.lichessId)) {
      try {
        await redis.del(key);
        result.reset++;
      } catch {
        /* reset errors ignored — следующий цикл повторит */
      }
      continue;
    }

    let count = 0;
    try {
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, ttlSeconds);
      }
      result.incremented++;
    } catch (e: unknown) {
      logger.warn(
        `[broadcast-sync] Redis incr failed for ${bc.lichessId}: ${(e as Error).message}`,
      );
      continue;
    }

    if (count >= staleCycles) {
      try {
        await prisma.broadcast.update({
          where: { id: bc.id },
          data: { isActive: false },
        });
        try {
          await redis.del(key);
        } catch {
          /* cleanup best-effort */
        }
        result.marked++;
        logger.log(
          `[broadcast-sync] Broadcast ${bc.lichessId} "${bc.title}" marked isActive=false after ${count} missed cycles`,
        );
      } catch (e: unknown) {
        logger.error(
          `[broadcast-sync] Failed to mark ${bc.lichessId} inactive: ${(e as Error).message}`,
        );
      }
    }
  }

  if (result.marked > 0) {
    logger.log(
      `[broadcast-sync] Stale check: marked ${result.marked} broadcasts isActive=false (cutoff=${staleCycles} cycles, scanned=${result.scanned})`,
    );
  }
  return result;
}
