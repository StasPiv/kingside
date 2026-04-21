import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ArchivePositionWriterService } from './archive-position-writer.service';
import { PositionIndexerService } from './position-indexer.service';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';
import { TwicImporter, type ArchiveSourceRow } from './sources/twic.importer';
import { intervalFromSchedule } from './interval-schedule';

/**
 * Оркестратор импорта.
 *
 * Раз в `TICK_INTERVAL_MS` обходит `archive_sources` с `enabled = true`,
 * для каждого «созревшего» источника берёт Redis-lock
 * (`archive:import:lock:{code}`) и запускает соответствующий импортёр.
 *
 * Отличия от старого `apps/archive-importer/src/importer.ts`:
 *   - планировщик — `@nestjs/schedule` `@Interval(60_000)` (ADR-019 §2.5)
 *     вместо setInterval;
 *   - зависимости инжектятся через DI, singleton-ы переживают tick'и;
 *   - ключ lock'а и TTL идентичны (`archive:import:lock:{code}`, 30 мин)
 *     — ADR-019 §2.11.
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

@Injectable()
export class ArchiveImportService implements OnModuleInit {
  private readonly logger = new Logger(ArchiveImportService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly positionWriter: ArchivePositionWriterService,
    private readonly indexer: PositionIndexerService,
    private readonly metrics: ArchiveImportMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('ArchiveImportService starting...');
    const dbUrl = (process.env.ARCHIVE_DATABASE_URL || '').replace(
      /\/\/[^@]*@/,
      '//***@',
    );
    this.logger.log(`ARCHIVE_DATABASE_URL=${dbUrl}`);
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      this.logger.log('DB reachable');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`DB UNREACHABLE: ${msg}`);
      // Не бросаем — importer-main умеет подняться c degraded health.
      return;
    }
    // Первый tick — сразу, не ждём минуту.
    this.tick().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`initial tick error: ${msg}`);
    });
    this.logger.log(`ArchiveImportService running — tick interval ${TICK_INTERVAL_MS}ms`);
  }

  /**
   * Один проход планировщика: ищем готовые к запуску источники и
   * обрабатываем.
   */
  @Interval(TICK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.log('tick skipped — previous tick still running');
      return;
    }
    this.running = true;
    try {
      const sources = await this.prisma.archiveSource.findMany({
        where: { enabled: true },
      });
      for (const source of sources) {
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
      this.logger.log(`${source.code}: lock held, skipping`);
      return;
    }

    this.logger.log(
      `${source.code}: starting import (kind=${source.kind}, cursor=${source.cursor})`,
    );
    try {
      await this.metrics.timeImport(source.code, async () => {
        if ((source.kind as SourceKind) === 'twic') {
          const importer = new TwicImporter(
            this.prisma,
            source as ArchiveSourceRow,
            this.positionWriter,
            this.indexer,
            this.metrics,
          );
          const result = await importer.run();
          this.logger.log(
            `${source.code}: status=${result.status} parsed=${result.gamesParsed} added=${result.gamesAdded} skipped=${result.gamesSkipped} cursor=${result.cursorBefore}→${result.cursorAfter}`,
          );
          if (result.status === 'failed' && result.error) {
            await this.prisma.archiveSource.update({
              where: { id: source.id },
              data: { lastRunAt: new Date(), lastError: result.error },
            });
          }
        } else {
          this.logger.warn(`${source.code}: unknown kind "${source.kind}"`);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`${source.code}: import failed: ${msg}`);
      await this.prisma.archiveSource
        .update({
          where: { id: source.id },
          data: { lastRunAt: new Date(), lastError: msg },
        })
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
  private isDue(source: {
    schedule: string | null;
    lastRunAt: Date | null;
  }): boolean {
    const now = Date.now();
    const last = source.lastRunAt?.getTime() ?? 0;
    const intervalMs = intervalFromSchedule(source.schedule);
    return now - last >= intervalMs;
  }
}
