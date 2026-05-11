/**
 * KS-2782. Core-логика backfill'а: пройти по `archive_games` батчами,
 * для каждой партии проверить PGN-header `[Variant "..."]` через
 * `isNonStandardVariantPgn` (KS-2781), удалить partition'ы non-standard
 * вариантов из БД. CLI-shim — `cli/backfill-variant-cleanup.ts`.
 *
 * Тестируется отдельно от DI: принимает только минимальный
 * Prisma-surface и logger через args. Mock'ируется в spec через объект
 * с теми же методами.
 */

import { isNonStandardVariantPgn } from './pgn-utils';

/**
 * Минимальный Prisma-surface для backfill'а. Используется реальный
 * `PrismaService` (archive) или mock.
 */
export interface BackfillVariantPrisma {
  archiveGame: {
    findMany: (args: {
      where?: { id: { gt: string } };
      select: { id: true; pgn: true };
      orderBy: { id: 'asc' };
      take: number;
    }) => Promise<Array<{ id: string; pgn: string }>>;
    deleteMany: (args: {
      where: { id: { in: string[] } };
    }) => Promise<{ count: number }>;
  };
}

export interface BackfillVariantOptions {
  /** Размер batch'а чтения. По умолчанию 1000. */
  batchSize?: number;
  /** Не выполнять DELETE, только лог. По умолчанию false. */
  dryRun?: boolean;
  /** Прогресс-лог каждые N batch'ей. По умолчанию 5. */
  logEveryNBatches?: number;
}

export interface BackfillVariantStats {
  checked: number;
  removed: number;
  batches: number;
  /** Последний обработанный UUID — для возобновления при рестарте. */
  lastCursor: string | null;
}

export type BackfillLogger = (line: string) => void;

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_LOG_EVERY = 5;
const PROGRESS_TAG = '[backfill-variant]';

/**
 * Основной loop. Возвращает stats после полного прохода.
 */
export async function runBackfillVariantCleanup(
  prisma: BackfillVariantPrisma,
  log: BackfillLogger,
  options: BackfillVariantOptions = {},
): Promise<BackfillVariantStats> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = options.dryRun ?? false;
  const logEvery = options.logEveryNBatches ?? DEFAULT_LOG_EVERY;

  const stats: BackfillVariantStats = {
    checked: 0,
    removed: 0,
    batches: 0,
    lastCursor: null,
  };

  log(
    `${PROGRESS_TAG} start: batchSize=${batchSize} dryRun=${dryRun} logEvery=${logEvery}`,
  );

  let cursor: string | null = null;
  while (true) {
    const rows = await prisma.archiveGame.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      select: { id: true, pgn: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (rows.length === 0) break;
    stats.batches++;
    stats.checked += rows.length;
    cursor = rows[rows.length - 1].id;
    stats.lastCursor = cursor;

    const toRemove = rows
      .filter((r) => isNonStandardVariantPgn(r.pgn))
      .map((r) => r.id);

    if (toRemove.length > 0) {
      if (!dryRun) {
        const r = await prisma.archiveGame.deleteMany({
          where: { id: { in: toRemove } },
        });
        stats.removed += r.count;
      } else {
        stats.removed += toRemove.length;
      }
    }

    if (stats.batches % logEvery === 0) {
      log(
        `${PROGRESS_TAG} progress: batches=${stats.batches} checked=${stats.checked} removed=${stats.removed}${dryRun ? ' (dry-run)' : ''} cursor=${cursor.slice(0, 8)}`,
      );
    }

    // Если последний batch неполный → конец таблицы.
    if (rows.length < batchSize) break;
  }

  log(
    `${PROGRESS_TAG} done: batches=${stats.batches} checked=${stats.checked} removed=${stats.removed}${dryRun ? ' (dry-run, ничего не удалено)' : ''}`,
  );
  return stats;
}

/**
 * Парсер CLI-аргументов `--dry-run`, `--batch-size=N`,
 * `--log-every=N`. Бросает на неизвестный флаг.
 */
export function parseBackfillVariantArgs(
  argv: readonly string[],
): BackfillVariantOptions {
  const opts: BackfillVariantOptions = {};
  for (const arg of argv) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
    const [, key, value] = m;
    switch (key) {
      case 'batch-size':
        opts.batchSize = parseInt(value, 10);
        if (!Number.isFinite(opts.batchSize) || opts.batchSize <= 0) {
          throw new Error(`Invalid --batch-size: ${value}`);
        }
        break;
      case 'log-every':
        opts.logEveryNBatches = parseInt(value, 10);
        if (
          !Number.isFinite(opts.logEveryNBatches) ||
          opts.logEveryNBatches <= 0
        ) {
          throw new Error(`Invalid --log-every: ${value}`);
        }
        break;
      default:
        throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  return opts;
}
