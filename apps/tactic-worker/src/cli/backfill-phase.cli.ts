/**
 * KS-3564 / ADR-094 §3.4, §3.6, §7. Subcommand `backfill-phase` —
 * one-shot backfill phase-тегов для исторических generated-puzzle'ов.
 *
 * Алгоритм:
 *   1. SELECT id, fen, themes FROM puzzles
 *        WHERE source = 'generated'
 *          AND themes !~* '(^| )(opening|middlegame|endgame)( |$)'
 *        LIMIT batchSize.
 *      Та же regex, что в KS-3563 audit query — word-boundaries
 *      защищают от ложных совпадений («preopening» и т.п.).
 *   2. detectPhase(fen) (импорт из puzzle-generator/tagging.ts) —
 *      возвращает одну из 'opening'|'middlegame'|'endgame'.
 *   3. UPDATE puzzles SET themes = trim(existing) + ' ' + phase
 *      WHERE id = $1. По 500 строк в Prisma $transaction.
 *   4. Лог progress per batch + финальный summary.
 *
 * Идемпотентно — WHERE-фильтр исключает уже размеченные. Повторный
 * запуск no-op для уже обработанных.
 *
 * НЕ trogaet `source='lichess'` — у lichess свои phase-теги.
 *
 * Запуск через ECS RunTask:
 *   containerOverrides.command =
 *     ["node","dist/main.js","backfill-phase","--dry-run"]
 *   ["node","dist/main.js","backfill-phase"]
 *   ["node","dist/main.js","backfill-phase","--batch-size=200","--limit=1000"]
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { detectPhase } from '../puzzle-generator/tagging';

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dryRun: false, limit: null, batchSize: 500 };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'dry-run':
        opts.dryRun = v === undefined || v === '' || v === 'true';
        break;
      case 'limit':
        opts.limit = parseInt(v, 10);
        break;
      case 'batch-size':
        opts.batchSize = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return opts;
}

/** Та же regex, что в KS-3563 audit query (`themes !~* …`). */
const PHASE_REGEX = '(^| )(opening|middlegame|endgame)( |$)';

interface PuzzleRow {
  id: string;
  fen: string;
  themes: string;
}

export interface BackfillPhaseStats {
  /** Сколько строк прочитали из БД суммарно. */
  scanned: number;
  /** Сколько обновили в БД (или посчитали для dry-run). */
  updated: number;
  /** detectPhase кинул — записи пропущены. */
  skipped: number;
  phases: { opening: number; middlegame: number; endgame: number };
  /** UPDATE упал по другой причине. */
  errors: number;
}

function emptyStats(): BackfillPhaseStats {
  return {
    scanned: 0,
    updated: 0,
    skipped: 0,
    phases: { opening: 0, middlegame: 0, endgame: 0 },
    errors: 0,
  };
}

export async function runBackfillPhase(
  app: INestApplicationContext,
  argv: string[],
): Promise<BackfillPhaseStats> {
  const logger = new Logger('cli:backfill-phase');
  const opts = parseArgs(argv);
  const prisma = app.get(PrismaService);

  logger.log(
    `start dryRun=${opts.dryRun} limit=${opts.limit ?? 'none'} ` +
      `batchSize=${opts.batchSize} regex='${PHASE_REGEX}'`,
  );

  const stats = emptyStats();
  const t0 = Date.now();

  // KS-3564 dry-run fix. Раньше dry-run крутился в бесконечном цикле,
  // потому что батч-WHERE возвращал те же 500 строк (UPDATE'ов нет
  // → row'ы не покидали выборку), а break срабатывал только на
  // `batch.length < take`, что не наступало. devops зафиксировал
  // 31M фантомных scanned за 580s до того как ECS waiter таймнул.
  //
  // Чиним: dry-run грузит ВСЁ за один SELECT (7K записей × 300 байт
  // ≈ 2 MB — комфортно для памяти), считает фазы и выходит. Никакого
  // батчинга dry-run больше не делает.
  if (opts.dryRun) {
    const limitClause =
      opts.limit !== null ? `LIMIT ${opts.limit}` : '';
    const allRows = (await prisma.$queryRawUnsafe(
      `SELECT id, fen, themes
         FROM puzzles
        WHERE source = 'generated'
          AND themes !~* $1
        ${limitClause}`,
      PHASE_REGEX,
    )) as PuzzleRow[];
    for (const row of allRows) {
      stats.scanned++;
      try {
        const phase = detectPhase(row.fen);
        stats.phases[phase]++;
        stats.updated++;
      } catch (err) {
        logger.warn(
          `detectPhase failed for id=${row.id}: ${(err as Error).message}`,
        );
        stats.skipped++;
      }
    }
    const dt0 = Math.round((Date.now() - t0) / 1000);
    logger.log(
      `DONE scanned=${stats.scanned} updated=${stats.updated} ` +
        `skipped=${stats.skipped} errors=${stats.errors} ` +
        `phases=${JSON.stringify(stats.phases)} ${dt0}s dryRun=true`,
    );
    return stats;
  }

  for (;;) {
    const remaining = opts.limit !== null ? opts.limit - stats.scanned : null;
    if (remaining !== null && remaining <= 0) {
      logger.log('limit reached, stop');
      break;
    }
    const take =
      remaining !== null ? Math.min(opts.batchSize, remaining) : opts.batchSize;

    const batch = (await prisma.$queryRawUnsafe(
      `SELECT id, fen, themes
         FROM puzzles
        WHERE source = 'generated'
          AND themes !~* $1
        LIMIT ${take}`,
      PHASE_REGEX,
    )) as PuzzleRow[];

    if (batch.length === 0) {
      logger.log('no more rows, exit');
      break;
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (const row of batch) {
          stats.scanned++;
          let phase: 'opening' | 'middlegame' | 'endgame';
          try {
            phase = detectPhase(row.fen);
          } catch (err) {
            logger.warn(
              `detectPhase failed for id=${row.id}: ` +
                `${(err as Error).message}`,
            );
            stats.skipped++;
            continue;
          }
          const existing = (row.themes ?? '').trim();
          const newThemes = existing ? `${existing} ${phase}` : phase;
          try {
            await tx.$executeRawUnsafe(
              `UPDATE puzzles SET themes = $1 WHERE id = $2`,
              newThemes,
              row.id,
            );
            stats.phases[phase]++;
            stats.updated++;
          } catch (err) {
            stats.errors++;
            logger.warn(
              `update failed for id=${row.id}: ${(err as Error).message}`,
            );
          }
        }
      });
    } catch (err) {
      logger.error(
        `batch transaction failed: ${(err as Error).message} — abort`,
      );
      throw err;
    }

    const dt = Math.round((Date.now() - t0) / 1000);
    logger.log(
      `batch=${batch.length} scanned=${stats.scanned} updated=${stats.updated} ` +
        `skipped=${stats.skipped} errors=${stats.errors} ` +
        `phases=${JSON.stringify(stats.phases)} ${dt}s`,
    );

    if (batch.length < take) {
      logger.log('partial batch — done');
      break;
    }
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  logger.log(
    `DONE scanned=${stats.scanned} updated=${stats.updated} ` +
      `skipped=${stats.skipped} errors=${stats.errors} ` +
      `phases=${JSON.stringify(stats.phases)} ${dt}s ` +
      `dryRun=${opts.dryRun}`,
  );
  return stats;
}
