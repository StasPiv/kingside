import { PrismaClient } from '@kingside/archive-db';
import Redis from 'ioredis';
import { TwicImporter } from './sources/twic.js';
import { ArchivePositionWriter } from './archive-position-writer.js';
import { archiveImportDurationSeconds } from './metrics.js';

/**
 * Главный цикл воркера.
 *
 * Каждые `TICK_INTERVAL_MS` обходит `archive_sources` с `enabled = true`,
 * вычисляет `nextRunAt` из `schedule` (cron) + `lastRunAt`, и если источник
 * «созрел» — берёт Redis-lock и запускает соответствующий импортёр.
 *
 * Планировщик намеренно не `@nestjs/schedule`: MVP, один процесс, простой
 * setInterval достаточен. ADR-013 §5.
 */

const TICK_INTERVAL_MS = 60_000;
const LOCK_TTL_SEC = 30 * 60;
const LOCK_KEY_PREFIX = 'archive:import:lock';

type SourceKind = 'twic';

interface SourceRow {
  id: string;
  code: string;
  kind: string;
  enabled: boolean;
  schedule: string | null;
  cursor: string | null;
  lastRunAt: Date | null;
}

export class ArchiveImporter {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly positionWriter: ArchivePositionWriter;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor() {
    this.prisma = new PrismaClient({ datasourceUrl: process.env.ARCHIVE_DATABASE_URL });
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.redis = new Redis({ host, port, lazyConnect: false });
    this.positionWriter = new ArchivePositionWriter(process.env.ARCHIVE_DATABASE_URL ?? '');
  }

  async start(): Promise<void> {
    console.log('[archive-importer] Starting...');
    const dbUrl = (process.env.ARCHIVE_DATABASE_URL || '').replace(/\/\/[^@]*@/, '//***@');
    console.log(`[archive-importer] ARCHIVE_DATABASE_URL=${dbUrl}`);
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      console.log('[archive-importer] DB reachable');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive-importer] DB UNREACHABLE: ${msg}`);
      throw err;
    }

    await this.tick();
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[archive-importer] tick error: ${msg}`);
      });
    }, TICK_INTERVAL_MS);
    console.log(`[archive-importer] Running — tick interval ${TICK_INTERVAL_MS}ms`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.redis.quit().catch(() => {});
    await this.positionWriter.close().catch(() => {});
    await this.prisma.$disconnect();
    console.log('[archive-importer] Stopped');
  }

  /** Один проход: ищем готовые к запуску источники и обрабатываем. */
  async tick(): Promise<void> {
    if (this.running) {
      console.log('[archive-importer] tick skipped — previous tick still running');
      return;
    }
    this.running = true;
    try {
      const sources = await this.prisma.archiveSource.findMany({
        where: { enabled: true },
      });
      for (const source of sources) {
        if (this.stopped) break;
        if (!this.isDue(source)) continue;
        await this.runSource({
          id: source.id,
          code: source.code,
          kind: source.kind,
          enabled: source.enabled,
          schedule: source.schedule ?? null,
          cursor: source.cursor ?? null,
          lastRunAt: source.lastRunAt ?? null,
        });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Запуск импорта одного источника: Redis-lock → импортёр → отпуск lock.
   * Повторяется безопасно — вторая копия воркера не запустит тот же импорт.
   */
  async runSource(source: SourceRow): Promise<void> {
    const lockKey = `${LOCK_KEY_PREFIX}:${source.code}`;
    const acquired = await this.redis
      .set(lockKey, `${process.pid}:${Date.now()}`, 'EX', LOCK_TTL_SEC, 'NX')
      .catch(() => null);
    if (acquired !== 'OK') {
      console.log(`[archive-importer] ${source.code}: lock held, skipping`);
      return;
    }

    console.log(`[archive-importer] ${source.code}: starting import (kind=${source.kind}, cursor=${source.cursor})`);
    try {
      await archiveImportDurationSeconds.time({ source: source.code }, async () => {
        if ((source.kind as SourceKind) === 'twic') {
          const importer = new TwicImporter(this.prisma, source, this.positionWriter);
          const result = await importer.run();
          console.log(
            `[archive-importer] ${source.code}: status=${result.status} parsed=${result.gamesParsed} added=${result.gamesAdded} skipped=${result.gamesSkipped} cursor=${result.cursorBefore}→${result.cursorAfter}`,
          );
          if (result.status === 'failed' && result.error) {
            await this.prisma.archiveSource.update({
              where: { id: source.id },
              data: { lastRunAt: new Date(), lastError: result.error },
            });
          }
        } else {
          console.warn(`[archive-importer] ${source.code}: unknown kind "${source.kind}"`);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive-importer] ${source.code}: import failed: ${msg}`);
      await this.prisma.archiveSource
        .update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: msg } })
        .catch(() => {});
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  /**
   * Проверяет, готов ли источник к следующему запуску.
   *
   * Если `schedule` пустой — минимальный интервал 60 минут от lastRunAt.
   * Иначе парсим простой cron (поддерживается `*\/N * * * *` и
   * `0 *\/N * * *`); для любых других форм — fallback 60 минут.
   * Полный cron-парсер добавится в KS-158x (отдельная задача).
   */
  private isDue(source: { schedule: string | null; lastRunAt: Date | null }): boolean {
    const now = Date.now();
    const last = source.lastRunAt?.getTime() ?? 0;
    const intervalMs = intervalFromSchedule(source.schedule);
    return now - last >= intervalMs;
  }
}

/**
 * Возвращает минимальный интервал между запусками в миллисекундах.
 * MVP: парсим только две формы cron, остальные — 60 минут.
 */
export function intervalFromSchedule(schedule: string | null): number {
  const fallbackMs = 60 * 60 * 1000;
  if (!schedule) return fallbackMs;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return fallbackMs;
  const [min, hr, dom, mon, dow] = parts;

  if (hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    const m = min.match(/^\*\/(\d+)$/);
    if (m) return Math.max(1, parseInt(m[1], 10)) * 60 * 1000;
  }
  if (min === '0' && dom === '*' && mon === '*' && dow === '*') {
    const m = hr.match(/^\*\/(\d+)$/);
    if (m) return Math.max(1, parseInt(m[1], 10)) * 60 * 60 * 1000;
  }
  return fallbackMs;
}
