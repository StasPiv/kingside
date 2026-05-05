/**
 * KS-2431 / ADR-041 §6 этап 1. CLI subcommand `generate-puzzles`.
 *
 * Образец — `index-tactic-drills.cli.ts` (KS-2438). Подключает:
 *   - `PrismaService` для записи в `puzzles`.
 *   - `StockfishService` для анализа позиций.
 *   - pg.Client к archive-RDS (через `pg-ssl.ts`).
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=postgresql://... DATABASE_URL=postgresql://... \
 *     node dist/main.js generate-puzzles \
 *       [--max-games=N]            default 100
 *       [--depth=N]                default 10  (KS-2431 калибровочное)
 *       [--multi-pv=N]             default 3
 *       [--min-rating=N]           default 1400
 *       [--min-ply=N]              default 20
 *       [--start-ply=N]            default 20
 *       [--min-eval-drop=N]        default 200 (cp)
 *       [--min-spread=N]           default 150 (cp)
 *       [--min-line-length=N]      default 2
 *       [--max-line-length=N]      default 6
 *       [--game-batch-size=N]      default 100
 *       [--cursor=UUID]            пропустить партии с id ≤ UUID
 *       [--dump-file=PATH]         если задан, дополнительно дампит
 *                                  до 30 первых puzzle'ов в JSON-файл
 *                                  (для chess-expert sample-test'а)
 */
import { Logger } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import { writeFile } from 'node:fs/promises';
import type { INestApplicationContext } from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../stockfish/stockfish.service';
import { buildArchivePgClientConfig } from '../lib/pg-ssl';
import {
  defaultGeneratorOptions,
  type GeneratorOptions,
  type PuzzleRecord,
} from '../puzzle-generator/types';
import { runPuzzleGenerator } from '../puzzle-generator/generator-pipeline';

interface CliFlags {
  options: Omit<GeneratorOptions, 'insertPuzzle'>;
  dumpFile: string | null;
}

export function parseArgs(argv: string[]): CliFlags {
  const opts = defaultGeneratorOptions();
  let dumpFile: string | null = null;
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'max-games':
        opts.maxGames = v === 'inf' ? Infinity : parseInt(v, 10);
        break;
      case 'depth':
        opts.depth = parseInt(v, 10);
        break;
      case 'multi-pv':
        opts.multiPV = parseInt(v, 10);
        break;
      case 'min-rating':
        opts.minRating = parseInt(v, 10);
        break;
      case 'min-ply':
        opts.minPly = parseInt(v, 10);
        break;
      case 'start-ply':
        opts.startPly = parseInt(v, 10);
        break;
      case 'min-eval-drop':
        opts.minEvalDrop = parseInt(v, 10);
        break;
      case 'min-spread':
        opts.minSpread = parseInt(v, 10);
        break;
      case 'min-line-length':
        opts.minLineLength = parseInt(v, 10);
        break;
      case 'max-line-length':
        opts.maxLineLength = parseInt(v, 10);
        break;
      case 'game-batch-size':
        opts.gameBatchSize = parseInt(v, 10);
        break;
      case 'cursor':
        opts.cursor = v;
        break;
      case 'dump-file':
        dumpFile = v;
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return { options: opts as Omit<GeneratorOptions, 'insertPuzzle'>, dumpFile };
}

export async function runGeneratePuzzles(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:generate-puzzles');
  const { options: parsed, dumpFile } = parseArgs(argv);

  process.stdout.write(
    `[puzzle-gen] starting ` +
      `depth=${parsed.depth} multiPV=${parsed.multiPV} ` +
      `minRating=${parsed.minRating} minEvalDrop=${parsed.minEvalDrop} ` +
      `minSpread=${parsed.minSpread} ` +
      `lineLen=${parsed.minLineLength}-${parsed.maxLineLength} ` +
      `cursor=${parsed.cursor ?? 'none'} ` +
      `maxGames=${parsed.maxGames === Infinity ? 'inf' : parsed.maxGames}\n`,
  );

  const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!archiveUrl) {
    throw new Error(
      'ARCHIVE_DATABASE_URL env not set; need read-access to archive_games',
    );
  }

  const prisma = app.get(PrismaService);
  const engine = app.get(StockfishService);

  const dumpBuffer: PuzzleRecord[] = [];
  const insertPuzzle = async (puzzle: PuzzleRecord): Promise<boolean> => {
    try {
      const data: Prisma.PuzzleUncheckedCreateInput = {
        id: puzzle.id,
        fen: puzzle.fen,
        moves: puzzle.moves,
        rating: puzzle.rating,
        ratingDev: puzzle.ratingDev,
        themes: puzzle.themes,
        source: puzzle.source,
        sourceType: puzzle.sourceType,
        sourceId: puzzle.sourceId,
        sourceMoveNum: puzzle.sourceMoveNum,
        gap: puzzle.gap,
        depth: puzzle.depth,
        isPublic: puzzle.isPublic,
        acceptedMoves: puzzle.acceptedMoves,
        sourceMetadata: puzzle.sourceMetadata,
      };
      const r = await prisma.puzzle.createMany({
        data: [data],
        skipDuplicates: true,
      });
      const inserted = r.count > 0;
      if (inserted && dumpFile && dumpBuffer.length < 30) {
        dumpBuffer.push(puzzle);
      }
      return inserted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`insert failed for ${puzzle.id}: ${msg}`);
      return false;
    }
  };

  const pgConfig = buildArchivePgClientConfig(
    archiveUrl,
    process.env,
    undefined,
    (msg) => process.stderr.write(`[puzzle-gen] WARN: ${msg}\n`),
  );
  const pg = new PgClient(pgConfig);
  await pg.connect();
  try {
    const stats = await runPuzzleGenerator({
      pg,
      engine,
      options: { ...parsed, insertPuzzle },
    });
    process.stdout.write(
      `[puzzle-gen] done. games=${stats.gamesProcessed} ` +
        `analyzed=${stats.positionsAnalyzed} ` +
        `inserted=${stats.inserted} ` +
        `lastCursor=${stats.lastCursor ?? 'none'}\n`,
    );

    if (dumpFile) {
      try {
        await writeFile(dumpFile, JSON.stringify(dumpBuffer, null, 2));
        process.stdout.write(
          `[puzzle-gen] dumped ${dumpBuffer.length} puzzles to ${dumpFile}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`dump-file write failed: ${msg}`);
      }
    }
  } finally {
    await pg.end().catch((err) => {
      logger.warn(`pg.end failed: ${(err as Error).message}`);
    });
  }
}
