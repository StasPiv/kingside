/**
 * KS-2245 (ADR-035 §6.3, Drills E5).
 *
 * Cron-scheduler инкрементальной индексации `tactic_drills` после
 * завершения `archive-importer` job'ов (новые партии TWIC).
 *
 * Альтернативы, рассмотренные в KS-2245:
 *   - hook в archive-importer'е: связывает два сервиса, требует
 *     доступа archive-service'а к основной БД (`tactic_drills`),
 *     а у него только `@kingside/archive-db`. Усложняет деплой.
 *   - отдельный воркер (выбран): NestJS `@Cron` в api, дёргает
 *     общий pipeline (`runIndexer` из `indexer-pipeline.ts`),
 *     cursor хранится в Redis.
 *
 * Cursor: `tactic-drill:incremental:cursor` — UUID последней
 * проиндексированной archive-game. Без TTL (persistent).
 *
 * Идемпотентность: `UNIQUE(type, fen)` (KS-2229) гарантирует, что
 * повторная индексация одного и того же FEN не создаёт дублей.
 *
 * Расписание: hourly (`@Cron(EVERY_HOUR)`). Для prod можно ужесточить
 * через ENV `TACTIC_DRILL_INCREMENTAL_CRON` (TBD KS-DRILL-OPS).
 *
 * Защита от перекрытий: `running` lock — если предыдущий tick ещё
 * работает (медленный TWIC import → много новых партий → долгая
 * индексация), второй вызов делает no-op до окончания первого.
 *
 * ENV:
 *   - `TACTIC_DRILL_INCREMENTAL_ENABLED=1` — включить scheduler
 *     (по умолчанию выключен; включается после KS-2229 indexer'а
 *     и покрытия архива до MVP).
 *   - `TACTIC_DRILL_INCREMENTAL_BATCH_GAMES=200` — gameBatchSize.
 *   - `ARCHIVE_DATABASE_URL` — обязателен; без него scheduler пишет
 *     warn и пропускает tick.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Client as PgClient } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  defaultIndexerOptions,
  runIndexer,
  type IndexerOptions,
  type IndexerStats,
} from './indexer-pipeline';
import { buildArchivePgClientConfig } from './pg-ssl';

const CURSOR_KEY = 'tactic-drill:incremental:cursor';

@Injectable()
export class TacticDrillIncrementalScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(TacticDrillIncrementalScheduler.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Никаких отдельных коннектов не держим — pg.Client открывается
    // на тик и закрывается. Ничего чистить не нужно.
  }

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (process.env.TACTIC_DRILL_INCREMENTAL_ENABLED !== '1') {
      return; // выключено по умолчанию (см. JSDoc)
    }
    if (this.running) {
      this.logger.warn(
        'incremental tick skipped: previous tick still running',
      );
      return;
    }
    const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
    if (!archiveUrl) {
      this.logger.warn(
        'ARCHIVE_DATABASE_URL is not set; skipping incremental tick',
      );
      return;
    }

    this.running = true;
    try {
      const stats = await this.runOnce(archiveUrl);
      this.logger.log(
        `incremental indexer: games=${stats.gamesProcessed} ` +
          `positions=${stats.positionsScanned} ` +
          `inserted=${stats.insertedTotal} ` +
          `drops.findFork.unsafeForker=` +
          `${stats.predicateDrops.findForkUnsafeForker} ` +
          `drops.findFork.overlap=` +
          `${stats.predicateDrops.findForkOverlap} ` +
          `lastCursor=${stats.lastCursor ?? 'unchanged'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`incremental tick failed: ${msg}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Один прогон: читаем cursor, индексируем новые партии,
   * сохраняем cursor. Public для unit-тестов.
   */
  async runOnce(archiveUrl: string): Promise<IndexerStats> {
    const cursor = (await this.redis.get(CURSOR_KEY)) || null;
    // KS-2411: явный verify-full SSL для archive-RDS — заменяет
    // NODE_TLS_REJECT_UNAUTHORIZED=0 в task-def'ах.
    const pgConfig = buildArchivePgClientConfig(
      archiveUrl,
      process.env,
      undefined,
      (msg) => this.logger.warn(msg),
    );
    const pg = new PgClient(pgConfig);
    await pg.connect();
    try {
      const options: IndexerOptions = {
        ...defaultIndexerOptions(),
        // perTypeTarget=Infinity для incremental — мы не лимитируем,
        // а индексируем всё новое. Если пул раздуется — devops
        // ставит TACTIC_DRILL_INCREMENTAL_ENABLED=0 или меняет
        // perTypeTarget через ENV в будущем (KS-DRILL-OPS).
        perTypeTarget: Number.POSITIVE_INFINITY,
        gameBatchSize: parseEnvInt(
          process.env.TACTIC_DRILL_INCREMENTAL_BATCH_GAMES,
          200,
        ),
        cursor,
        log: (line) => this.logger.log(line),
      };
      const stats = await runIndexer({
        prisma: this.prisma,
        pg,
        options,
        source: 'archive-incremental',
      });
      if (stats.lastCursor) {
        await this.redis.set(CURSOR_KEY, stats.lastCursor);
      }
      return stats;
    } finally {
      await pg.end().catch(() => {});
    }
  }

  /** Ручной reset cursor'а — для KS-DRILL-OPS smoke-tests. */
  async resetCursor(): Promise<void> {
    await this.redis.del(CURSOR_KEY);
  }
}

function parseEnvInt(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
