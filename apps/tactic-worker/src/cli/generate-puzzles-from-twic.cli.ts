/**
 * KS-3150 — CLI `generate-puzzles-from-twic`.
 *
 * Целевой запуск: один TWIC issue (либо явно через `--twic-issue=N`, либо
 * автоматически берётся последний успешно импортированный) прогоняется
 * через стандартный YOLO/WDL puzzle-генератор, и в БД сохраняются
 * только пазлы выбранного objective (по умолчанию `saveEquality` —
 * банк save-пазлов сейчас пуст, см. KS-3148: на 1518 PVE 1 save).
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
 *     node dist/main.js generate-puzzles-from-twic \
 *       [--twic-issue=N]      default: последний успешный из archive_imports
 *       [--only-save]         default true (-- save-only режим)
 *       [--all]               отключает фильтр (сохраняем оба objective)
 *       [--dry-run]           без INSERT, считаем что бы сохранил
 *       [--limit=N]           ограничить число партий (для отладки)
 *       [--time-ms=N]         Stockfish-лимит на позицию (default 1000)
 *       [--depth=N], [--nodes=N]
 *       [--half-moves-n=N], [--win-threshold=W], [--fail-threshold=F]
 *       [--start-ply=N]
 *
 * Дедупликация: тот же механизм что в `generate-puzzles` —
 * `puzzles.fen UNIQUE`, при коллизии `skipDuplicates:true` молча
 * пропустит вставку. Дополнительной защиты не делаем.
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Client as PgClient } from 'pg';
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

export interface TwicCliFlags {
  twicIssue: number | null;
  onlySave: boolean;
  dryRun: boolean;
  limit: number | null;
  options: Omit<GeneratorOptions, 'insertPuzzle'>;
}

export function parseArgs(argv: string[]): TwicCliFlags {
  const opts = defaultGeneratorOptions();
  let twicIssue: number | null = null;
  let onlySave = true;
  let dryRun = false;
  let limit: number | null = null;
  // KS-3364 follow-up: трекаем явные --time-ms / --nodes (см. описание
  // в `generate-puzzles.cli.ts`).
  let timeMsExplicit = false;
  let nodesExplicit = false;

  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'twic-issue':
        twicIssue = parseInt(v, 10);
        if (!Number.isFinite(twicIssue) || twicIssue <= 0) {
          throw new Error(`bad --twic-issue: ${v}`);
        }
        break;
      case 'only-save':
        onlySave = v === undefined || v === '' || v === 'true';
        break;
      case 'all':
        onlySave = false;
        break;
      case 'dry-run':
        dryRun = v === undefined || v === '' || v === 'true';
        break;
      case 'limit':
        limit = parseInt(v, 10);
        break;
      case 'time-ms':
        opts.engineLimit = { ...opts.engineLimit, timeMs: parseInt(v, 10) };
        timeMsExplicit = true;
        break;
      case 'depth':
        opts.engineLimit = { ...opts.engineLimit, depth: parseInt(v, 10) };
        break;
      case 'nodes':
        opts.engineLimit = { ...opts.engineLimit, nodes: parseInt(v, 10) };
        nodesExplicit = true;
        break;
      case 'half-moves-n':
        opts.halfMovesN = parseInt(v, 10);
        break;
      case 'win-threshold':
        opts.winThreshold = parseFloat(v);
        break;
      case 'fail-threshold':
        opts.failThreshold = parseFloat(v);
        break;
      case 'start-ply':
        opts.startPly = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }

  if (limit !== null) {
    opts.maxGames = limit;
  }

  // KS-3364 follow-up: только --nodes → убираем дефолтный timeMs из
  // engineLimit (иначе Stockfish стопает по time-cap раньше, чем по
  // nodes — см. описание в `generate-puzzles.cli.ts`).
  if (nodesExplicit && !timeMsExplicit) {
    const { timeMs: _ignored, ...rest } = opts.engineLimit;
    void _ignored;
    opts.engineLimit = rest;
  }

  return {
    twicIssue,
    onlySave,
    dryRun,
    limit,
    options: opts as Omit<GeneratorOptions, 'insertPuzzle'>,
  };
}

/**
 * Найти `archive_imports.id` для указанного TWIC-выпуска. Если issue не
 * задан — берём последний успешный (по started_at DESC).
 *
 * Возвращает `{importId, issue, fileName}` или null если не найден.
 */
export async function resolveTwicImportId(
  pg: Pick<PgClient, 'query'>,
  issue: number | null,
): Promise<{ importId: string; issue: number; fileName: string | null } | null> {
  // 1) sourceId для code='twic'.
  const sourceRes = (await pg.query(
    `SELECT id FROM archive_sources WHERE code = 'twic' LIMIT 1`,
  )) as { rows: Array<{ id: string }> };
  if (sourceRes.rows.length === 0) return null;
  const sourceId = sourceRes.rows[0].id;

  // 2) находим конкретный import.
  let importRow: { id: string; cursor_after: string | null; file_name: string | null } | null = null;
  if (issue !== null) {
    // По cursor_after, либо по file_name LIKE 'twic{N}g%' как fallback.
    const r = (await pg.query(
      `SELECT id, cursor_after, file_name
       FROM archive_imports
       WHERE source_id = $1
         AND status = 'ok'
         AND (cursor_after = $2 OR file_name LIKE $3)
       ORDER BY started_at DESC
       LIMIT 1`,
      [sourceId, String(issue), `twic${issue}g%`],
    )) as { rows: Array<{ id: string; cursor_after: string | null; file_name: string | null }> };
    importRow = r.rows[0] ?? null;
  } else {
    // Последний успешный по started_at.
    const r = (await pg.query(
      `SELECT id, cursor_after, file_name
       FROM archive_imports
       WHERE source_id = $1 AND status = 'ok'
       ORDER BY started_at DESC
       LIMIT 1`,
      [sourceId],
    )) as { rows: Array<{ id: string; cursor_after: string | null; file_name: string | null }> };
    importRow = r.rows[0] ?? null;
  }

  if (!importRow) return null;

  const issueNum =
    issue ??
    (importRow.cursor_after && /^\d+$/.test(importRow.cursor_after)
      ? Number.parseInt(importRow.cursor_after, 10)
      : extractIssueFromFileName(importRow.file_name) ?? 0);

  return {
    importId: importRow.id,
    issue: issueNum,
    fileName: importRow.file_name,
  };
}

function extractIssueFromFileName(name: string | null): number | null {
  if (!name) return null;
  const m = /twic(\d+)g/.exec(name);
  return m ? Number.parseInt(m[1], 10) : null;
}

export interface TwicGenStats {
  twicIssue: number;
  importId: string;
  scanned: number;
  inserted: number;
  savedConvertAdvantage: number;
  savedSaveEquality: number;
  skippedByObjectiveFilter: number;
  duplicateOrInsertFailed: number;
}

function emptyStats(twicIssue: number, importId: string): TwicGenStats {
  return {
    twicIssue,
    importId,
    scanned: 0,
    inserted: 0,
    savedConvertAdvantage: 0,
    savedSaveEquality: 0,
    skippedByObjectiveFilter: 0,
    duplicateOrInsertFailed: 0,
  };
}

function extractObjective(meta: string | null): 'convertAdvantage' | 'saveEquality' | null {
  if (!meta) return null;
  try {
    const obj = JSON.parse(meta) as Record<string, unknown>;
    const v = obj.objective;
    if (v === 'convertAdvantage' || v === 'saveEquality') return v;
  } catch {
    return null;
  }
  return null;
}

export async function runGeneratePuzzlesFromTwic(
  app: INestApplicationContext,
  argv: string[],
): Promise<TwicGenStats | null> {
  const logger = new Logger('cli:generate-puzzles-from-twic');
  const parsed = parseArgs(argv);

  const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!archiveUrl) {
    throw new Error('ARCHIVE_DATABASE_URL env not set');
  }

  const prisma = app.get(PrismaService);
  const engine = app.get(StockfishService);

  const pgConfig = buildArchivePgClientConfig(
    archiveUrl,
    process.env,
    undefined,
    (msg) => process.stderr.write(`[twic-puzzle-gen] WARN: ${msg}\n`),
  );
  const pg = new PgClient(pgConfig);
  await pg.connect();

  try {
    const resolved = await resolveTwicImportId(pg, parsed.twicIssue);
    if (!resolved) {
      const detail =
        parsed.twicIssue !== null
          ? `TWIC issue ${parsed.twicIssue} not found in archive_imports`
          : 'no successful TWIC imports found in archive_imports';
      logger.warn(detail);
      process.stdout.write(`[twic-puzzle-gen] ${detail}\n`);
      return null;
    }
    const { importId, issue, fileName } = resolved;

    process.stdout.write(
      `[twic-puzzle-gen] start issue=${issue} importId=${importId} ` +
        `file=${fileName ?? 'n/a'} onlySave=${parsed.onlySave} ` +
        `dryRun=${parsed.dryRun} limit=${parsed.limit ?? 'none'} ` +
        `time-ms=${parsed.options.engineLimit.timeMs}\n`,
    );

    const stats = emptyStats(issue, importId);

    const insertPuzzle = async (puzzle: PuzzleRecord): Promise<boolean> => {
      stats.scanned++;
      const objective = extractObjective(puzzle.sourceMetadata);
      if (parsed.onlySave && objective !== 'saveEquality') {
        stats.skippedByObjectiveFilter++;
        return false;
      }
      if (parsed.dryRun) {
        stats.inserted++;
        if (objective === 'convertAdvantage') stats.savedConvertAdvantage++;
        else if (objective === 'saveEquality') stats.savedSaveEquality++;
        return true;
      }
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
          solutionMode: puzzle.solutionMode,
          sourceWhiteElo: puzzle.sourceWhiteElo,
          sourceBlackElo: puzzle.sourceBlackElo,
        };
        const r = await prisma.puzzle.createMany({
          data: [data],
          skipDuplicates: true,
        });
        if (r.count > 0) {
          stats.inserted++;
          if (objective === 'convertAdvantage') stats.savedConvertAdvantage++;
          else if (objective === 'saveEquality') stats.savedSaveEquality++;
          return true;
        }
        stats.duplicateOrInsertFailed++;
        return false;
      } catch (err) {
        stats.duplicateOrInsertFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`insert failed for ${puzzle.id}: ${msg}`);
        return false;
      }
    };

    // Используем существующий `runPuzzleGenerator` через тот же
    // `importId`-фильтр (KS-2776). Никакого собственного обхода партий
    // не делаем — алгоритм и пороги одинаковы с `generate-puzzles`.
    const genStats = await runPuzzleGenerator({
      pg,
      engine,
      options: {
        ...parsed.options,
        importId,
        insertPuzzle,
      },
    });

    process.stdout.write(
      `[twic-puzzle-gen] done. games=${genStats.gamesProcessed} ` +
        `positions=${genStats.positionsAnalyzed} ` +
        `insertedByGen=${genStats.inserted} ` +
        `scannedByCli=${stats.scanned} ` +
        `inserted=${stats.inserted} (convert=${stats.savedConvertAdvantage} ` +
        `save=${stats.savedSaveEquality}) ` +
        `skippedByObjectiveFilter=${stats.skippedByObjectiveFilter} ` +
        `duplicateOrInsertFailed=${stats.duplicateOrInsertFailed}\n`,
    );
    process.stdout.write('=== KS-3150 TWIC GEN STATS ===\n');
    process.stdout.write(JSON.stringify(stats, null, 2));
    process.stdout.write('\n=== END ===\n');
    return stats;
  } finally {
    await pg.end().catch((err) => {
      logger.warn(`pg.end failed: ${(err as Error).message}`);
    });
  }
}
