/**
 * KS-3568 / ADR-094 §8.7, §8.10, §8.12 + KS-3574 / ADR-094 §8.11.
 * Subcommand `backfill-endgame-subtype` — one-shot для проставления
 * подвидового тега для исторических generated-puzzle'ов, у которых
 * УЖЕ есть зонтичный `endgame` от KS-3562 / KS-3564, но нет подвида
 * от KS-3567/KS-3574.
 *
 * Подвиды (7): pawnEndgame / rookEndgame / queenEndgame /
 * knightEndgame / bishopEndgame / queenRookEndgame / mixedEndgame.
 *
 * Семантика после KS-3574: `detectEndgameSubtype` больше не возвращает
 * null. Любой эндшпиль получает один из 7 тегов. Раньше смешанные
 * (R+N, B+N, Q+R+B и т.п.) пропускались — теперь получают `mixedEndgame`.
 *
 * Алгоритм:
 *   1. SELECT id, fen, themes FROM puzzles
 *      WHERE source='generated'
 *        AND themes ~* '(^| )endgame( |$)'
 *        AND themes !~* '(^| )(pawnEndgame|rookEndgame|queenEndgame
 *                              |knightEndgame|bishopEndgame
 *                              |queenRookEndgame|mixedEndgame)( |$)'
 *        AND id > $lastId
 *      ORDER BY id LIMIT batchSize.
 *   2. detectEndgameSubtype(fen) → один из 7 подвидов (всегда).
 *   3. UPDATE themes = trim(existing) + ' ' + subtype.
 *   4. Прогресс per batch. По 500 строк — Prisma $transaction.
 *
 * Keyset-пагинация по `id > $lastId` — оставлена для устойчивости к
 * (теоретически возможным) ошибкам обновления: failed row не выпадет
 * из WHERE'а и без keyset'а зацикливал бы выборку.
 *
 * Идемпотентно: WHERE-фильтр исключает уже размеченных. Повторный
 * запуск — no-op для уже обработанных. **Важно**: после KS-3574
 * первый запуск на проде допроставит `mixedEndgame` для row'ов,
 * которые KS-3568 (предыдущая итерация backfill'а) пропустил как
 * null-subtype. Audit KS-3569: таких 1612 строк (69.7% эндшпилей).
 *
 * НЕ trogaet `source='lichess'` — у них свои подвиды.
 *
 * Запуск через ECS RunTask:
 *   containerOverrides.command =
 *     ["node","dist/main.js","backfill-endgame-subtype","--dry-run"]
 *   ["node","dist/main.js","backfill-endgame-subtype"]
 *   ["node","dist/main.js","backfill-endgame-subtype","--batch-size=200","--limit=1000"]
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  detectEndgameSubtype,
  type EndgameSubtype,
} from '../puzzle-generator/tagging';

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

/** Endgame regex (word-boundaries, case-insensitive). Совпадает с
 *  KS-3563 audit'ом и KS-3564 backfill'ом для консистентности. */
const ENDGAME_REGEX = '(^| )endgame( |$)';

/**
 * Exclusion regex — все 7 подвидов перечислены явно.
 * KS-3574 добавил `mixedEndgame` — после первого прогона backfill'а
 * row'ы со смешанной фигурной композицией получат этот тег и не
 * попадут в выборку повторно.
 */
const SUBTYPE_REGEX =
  '(^| )(pawnEndgame|rookEndgame|queenEndgame|knightEndgame|bishopEndgame|queenRookEndgame|mixedEndgame)( |$)';

interface PuzzleRow {
  id: string;
  fen: string;
  themes: string;
}

export interface BackfillEndgameSubtypeStats {
  scanned: number;
  updated: number;
  /**
   * KS-3574: после расширения `detectEndgameSubtype` на `mixedEndgame`
   * пропусков по null больше нет. Поле сохранено для back-compat с
   * историческими стат-отчётами KS-3568 — всегда `0` в текущей версии.
   */
  skippedMixed: number;
  /** detectEndgameSubtype бросил исключение. */
  errors: number;
  subtypes: Record<EndgameSubtype, number>;
}

function emptyStats(): BackfillEndgameSubtypeStats {
  return {
    scanned: 0,
    updated: 0,
    skippedMixed: 0,
    errors: 0,
    subtypes: {
      pawnEndgame: 0,
      rookEndgame: 0,
      queenEndgame: 0,
      knightEndgame: 0,
      bishopEndgame: 0,
      queenRookEndgame: 0,
      mixedEndgame: 0,
    },
  };
}

export async function runBackfillEndgameSubtype(
  app: INestApplicationContext,
  argv: string[],
): Promise<BackfillEndgameSubtypeStats> {
  const logger = new Logger('cli:backfill-endgame-subtype');
  const opts = parseArgs(argv);
  const prisma = app.get(PrismaService);

  logger.log(
    `start dryRun=${opts.dryRun} limit=${opts.limit ?? 'none'} ` +
      `batchSize=${opts.batchSize} endgameRegex='${ENDGAME_REGEX}' ` +
      `subtypeRegex='${SUBTYPE_REGEX}'`,
  );

  const stats = emptyStats();
  const t0 = Date.now();
  let lastId: string | null = null;

  for (;;) {
    const remaining = opts.limit !== null ? opts.limit - stats.scanned : null;
    if (remaining !== null && remaining <= 0) {
      logger.log('limit reached, stop');
      break;
    }
    const take =
      remaining !== null ? Math.min(opts.batchSize, remaining) : opts.batchSize;

    const params: unknown[] = [ENDGAME_REGEX, SUBTYPE_REGEX];
    let lastIdClause = '';
    if (lastId !== null) {
      params.push(lastId);
      lastIdClause = `AND id > $3`;
    }

    const batch = (await prisma.$queryRawUnsafe(
      `SELECT id, fen, themes
         FROM puzzles
        WHERE source = 'generated'
          AND themes ~* $1
          AND themes !~* $2
          ${lastIdClause}
        ORDER BY id
        LIMIT ${take}`,
      ...params,
    )) as PuzzleRow[];

    if (batch.length === 0) {
      logger.log('no more rows, exit');
      break;
    }

    if (opts.dryRun) {
      for (const row of batch) {
        stats.scanned++;
        try {
          const subtype = detectEndgameSubtype(row.fen);
          stats.subtypes[subtype]++;
          stats.updated++;
        } catch (err) {
          logger.warn(
            `detectEndgameSubtype failed for id=${row.id}: ` +
              `${(err as Error).message}`,
          );
          stats.errors++;
        }
      }
    } else {
      try {
        await prisma.$transaction(async (tx) => {
          for (const row of batch) {
            stats.scanned++;
            let subtype: EndgameSubtype;
            try {
              subtype = detectEndgameSubtype(row.fen);
            } catch (err) {
              logger.warn(
                `detectEndgameSubtype failed for id=${row.id}: ` +
                  `${(err as Error).message}`,
              );
              stats.errors++;
              continue;
            }
            const existing = (row.themes ?? '').trim();
            const newThemes = existing ? `${existing} ${subtype}` : subtype;
            try {
              await tx.$executeRawUnsafe(
                `UPDATE puzzles SET themes = $1 WHERE id = $2`,
                newThemes,
                row.id,
              );
              stats.subtypes[subtype]++;
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
    }

    // Keyset advance — последний `id` пачки (sorted ASC).
    lastId = batch[batch.length - 1].id;

    const dt = Math.round((Date.now() - t0) / 1000);
    logger.log(
      `batch=${batch.length} scanned=${stats.scanned} updated=${stats.updated} ` +
        `skippedMixed=${stats.skippedMixed} errors=${stats.errors} ` +
        `subtypes=${JSON.stringify(stats.subtypes)} ${dt}s`,
    );

    if (batch.length < take) {
      logger.log('partial batch — done');
      break;
    }
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  logger.log(
    `DONE scanned=${stats.scanned} updated=${stats.updated} ` +
      `skippedMixed=${stats.skippedMixed} errors=${stats.errors} ` +
      `subtypes=${JSON.stringify(stats.subtypes)} ${dt}s ` +
      `dryRun=${opts.dryRun}`,
  );
  return stats;
}
