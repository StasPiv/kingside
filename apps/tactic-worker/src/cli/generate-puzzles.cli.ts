/**
 * KS-2464 / ADR-044 §6. CLI subcommand `generate-puzzles` (play-vs-engine).
 *
 * Подключает PrismaService для записи в `puzzles`, StockfishService
 * с UCI_ShowWDL для анализа. pg.Client к archive-RDS через pg-ssl.ts.
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=postgresql://... DATABASE_URL=postgresql://... \
 *     node dist/main.js generate-puzzles \
 *       [--solution-mode=play-vs-engine|forced-line]  default play-vs-engine
 *       [--max-games=N]            default 100
 *       # KS-3136 / ADR-068 §1.2: пороги deltaW/deltaD/minWAfterForSolver/
 *       # minWPlusDAfterForSolver hardcoded в `generator-pipeline.ts`
 *       # (HARD_*), CLI-флагов нет.
 *       [--time-ms=N]              default 1000
 *       [--depth=N]                опц. (по умолчанию используется time-ms)
 *       [--nodes=N]                опц.
 *       [--half-moves-n=N]         default 6   (полуходов в solvability-check)
 *       [--win-threshold=W]        default 0.5
 *       [--fail-threshold=F]       default 0.0
           *       [--skip-decided-wdl=W]     KS-3140: игнорируется (фильтр снят)
 *       [--min-rating=N]           default 1400
 *       [--min-ply=N]              default 20
 *       [--start-ply=N]            default 20
 *       [--game-batch-size=N]      default 100
 *       [--cursor=UUID]            пропустить партии с id ≤ UUID
 *       [--shard=i/N]              KS-3396: брать только свой шард (i=0..N-1)
 *       [--dump-file=PATH]         дамп до 30 первых puzzle'ов в JSON
 *
 *   Legacy forced-line флаги (--spread-delta, --continue-spread-delta,
 *   --min-line-length, --max-line-length) принимаются, но в режиме
 *   play-vs-engine игнорируются.
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
  /** KS-2776. true → перед циклом выгрузить source_id'шки из puzzles main БД. */
  excludeUsed: boolean;
}

export function parseArgs(argv: string[]): CliFlags {
  const opts = defaultGeneratorOptions();
  let dumpFile: string | null = null;
  let excludeUsed = false;
  // KS-3364 follow-up: трекаем явные --time-ms / --nodes, чтобы после
  // прохода по argv убрать дефолтный `timeMs: 1000` из engineLimit, если
  // пользователь указал ТОЛЬКО `--nodes`. Иначе Stockfish получает оба
  // лимита и стопает по первому достигнутому (обычно time), сводя на нет
  // эффект nodes-limit.
  let timeMsExplicit = false;
  let nodesExplicit = false;
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'max-games':
        opts.maxGames = v === 'inf' ? Infinity : parseInt(v, 10);
        break;
      case 'spread-delta':
        opts.spreadDelta = parseFloat(v);
        break;
      case 'continue-spread-delta':
        opts.continueSpreadDelta = parseFloat(v);
        break;
      case 'depth':
        opts.engineLimit = { ...opts.engineLimit, depth: parseInt(v, 10) };
        break;
      case 'time-ms':
        opts.engineLimit = { ...opts.engineLimit, timeMs: parseInt(v, 10) };
        timeMsExplicit = true;
        break;
      case 'nodes':
        opts.engineLimit = { ...opts.engineLimit, nodes: parseInt(v, 10) };
        nodesExplicit = true;
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
      case 'solution-mode':
        if (v !== 'play-vs-engine' && v !== 'forced-line') {
          throw new Error(
            `unknown solution-mode: ${v} (allowed: play-vs-engine | forced-line)`,
          );
        }
        opts.solutionMode = v;
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
      case 'skip-decided-wdl':
        // KS-3140: фильтр snyt, флаг сохранён для обратной совместимости
        // CLI — значение записывается, но pipeline его игнорирует.
        opts.skipDecidedWdl = parseFloat(v);
        break;
      case 'import-id':
        // KS-2776. Фильтр по archive_games.import_id.
        opts.importId = v;
        break;
      case 'exclude-used':
        // KS-2776. Boolean-флаг (`--exclude-used` без значения = true).
        excludeUsed = v === undefined || v === '' || v === 'true';
        break;
      case 'shard': {
        // KS-3396. Горизонтальный шардинг: --shard=i/N (i=0..N-1).
        const m = /^(\d+)\/(\d+)$/.exec(v ?? '');
        if (!m) {
          throw new Error(`bad --shard: ${v} (expected i/N, e.g. 0/4)`);
        }
        const i = parseInt(m[1], 10);
        const n = parseInt(m[2], 10);
        if (n < 1 || i < 0 || i >= n) {
          throw new Error(
            `bad --shard: ${v} (need N>=1 and 0<=i<N, got i=${i} N=${n})`,
          );
        }
        opts.shardIndex = i;
        opts.shardCount = n;
        break;
      }
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  // KS-3364 follow-up: если пользователь передал ТОЛЬКО --nodes (без
  // --time-ms), убираем унаследованный из defaultGeneratorOptions
  // `timeMs: 1000`. Иначе движок останавливается по time-cap раньше,
  // чем достигнет nodes — фактический лимит = time=1000ms.
  if (nodesExplicit && !timeMsExplicit) {
    const { timeMs: _ignored, ...rest } = opts.engineLimit;
    void _ignored;
    opts.engineLimit = rest;
  }
  return {
    options: opts as Omit<GeneratorOptions, 'insertPuzzle'>,
    dumpFile,
    excludeUsed,
  };
}

export async function runGeneratePuzzles(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:generate-puzzles');
  const { options: parsed, dumpFile, excludeUsed } = parseArgs(argv);

  process.stdout.write(
    `[puzzle-gen] starting solutionMode=${parsed.solutionMode} ` +
      // KS-3136 / ADR-068: пороги дельт hardcoded в pipeline; в лог не
      // выводим — они константы релиза.
      `halfMovesN=${parsed.halfMovesN} ` +
      `win=${parsed.winThreshold} fail=${parsed.failThreshold} ` +
      `skipDecidedWdl=${parsed.skipDecidedWdl} ` +
      `limit={depth=${parsed.engineLimit.depth},time=${parsed.engineLimit.timeMs}ms,nodes=${parsed.engineLimit.nodes}} ` +
      `minRating=${parsed.minRating} ` +
      `cursor=${parsed.cursor ?? 'none'} ` +
      `importId=${parsed.importId ?? 'none'} ` +
      `shard=${parsed.shardCount && parsed.shardCount > 1 ? `${parsed.shardIndex}/${parsed.shardCount}` : 'none'} ` +
      `excludeUsed=${excludeUsed} ` +
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

  // KS-2776. Если --exclude-used — выгрузим source_id всех PVE-пазлов
  // из main `puzzles` и передадим в pipeline для исключения из выборки
  // archive_games. Тем самым на одной партии-источнике не плодим
  // дубль-пазлы при повторном прогоне.
  let excludeGameIds: string[] = [];
  if (excludeUsed) {
    const rows = await prisma.puzzle.findMany({
      where: { solutionMode: 'play-vs-engine', sourceId: { not: null } },
      select: { sourceId: true },
    });
    excludeGameIds = rows
      .map((r) => r.sourceId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    process.stdout.write(
      `[puzzle-gen] excludeUsed: loaded ${excludeGameIds.length} source_id from puzzles\n`,
    );
  }

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
        solutionMode: puzzle.solutionMode,
        // KS-2762. Денормализованные ELO для фильтра /precision.
        sourceWhiteElo: puzzle.sourceWhiteElo,
        sourceBlackElo: puzzle.sourceBlackElo,
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
      options: { ...parsed, insertPuzzle, excludeGameIds },
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
