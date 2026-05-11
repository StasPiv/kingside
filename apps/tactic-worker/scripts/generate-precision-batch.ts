/**
 * KS-2697 / ADR-041 etap-1.
 *
 * One-shot batch для наполнения раздела `/precision` пазлами в режиме
 * `play-vs-engine`. Pre-filter на classical + оба игрока Elo ≥ 2400.
 *
 * Post-filter — максимум один пазл на партию: если в партии нашлось
 * несколько кандидатов, оставляем САМЫЙ ЯРКИЙ по `blunderDelta`.
 * Pipeline (`apps/tactic-worker/src/puzzle-generator/`) не меняем —
 * фильтр + флоу записи делается в `insertPuzzle` callback'е.
 *
 * Stream-режим записи: сразу INSERT в БД при первом кандидате партии.
 * Если приходит лучший — DELETE старого + INSERT нового. Гарантируем,
 * что при kill процесса найденные пазлы остаются в БД.
 *
 * Early-exit: когда `inserted` достигает `--target`, скрипт вызывает
 * `process.exit(0)` без ожидания дальнейшего pipeline'а.
 *
 * Запуск:
 *   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
 *     npx ts-node apps/tactic-worker/scripts/generate-precision-batch.ts \
 *     --target=100 [--depth=14] [--blunder-delta=0.6]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Client as PgClient } from 'pg';
import type { Prisma } from '@kingside/db';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { StockfishService } from '../src/stockfish/stockfish.service';
import { buildArchivePgClientConfig } from '../src/lib/pg-ssl';
import {
  defaultGeneratorOptions,
  type PuzzleRecord,
  type GeneratorOptions,
} from '../src/puzzle-generator/types';
import { runPuzzleGenerator } from '../src/puzzle-generator/generator-pipeline';

interface CliFlags {
  target: number;
  depth: number;
  blunderDelta: number;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    target: 100,
    depth: 14,
    blunderDelta: 0.6,
    dryRun: false,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    switch (k) {
      case 'target':
        flags.target = parseInt(v, 10);
        break;
      case 'depth':
        flags.depth = parseInt(v, 10);
        break;
      case 'blunder-delta':
        flags.blunderDelta = parseFloat(v);
        break;
      case 'dry-run':
        flags.dryRun = v !== 'false';
        break;
      default:
        if (k) throw new Error(`Unknown flag: --${k}`);
    }
  }
  return flags;
}

interface BufferEntry {
  /** Текущий лучший пазл по blunderDelta. */
  puzzle: PuzzleRecord;
  /** ID, под которым пазл записан в БД (нужен для DELETE при upgrade). */
  dbId: string;
  blunderDelta: number;
}

class EarlyExitSignal extends Error {
  constructor(public readonly bufferSize: number) {
    super(`target ${bufferSize} reached`);
    this.name = 'EarlyExitSignal';
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const t0 = Date.now();
  process.stdout.write(
    `[batch] target=${flags.target} depth=${flags.depth} ` +
      `blunderDelta=${flags.blunderDelta} dryRun=${flags.dryRun}\n`,
  );

  const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!archiveUrl) {
    throw new Error('ARCHIVE_DATABASE_URL not set');
  }

  // ── 1. Получаем allowedGameIds (classical + оба ≥ 2400). ─────────
  // Берём targetX5 для запаса — pipeline отбросит часть на drops.
  const filterPg = new PgClient(
    buildArchivePgClientConfig(archiveUrl, process.env, undefined, (m) =>
      process.stderr.write(`[batch] WARN: ${m}\n`),
    ),
  );
  await filterPg.connect();
  const filterRes = await filterPg.query<{ id: string }>(
    `SELECT id::text AS id FROM archive_games
     WHERE time_control_category = 'classical'
       AND white_elo >= 2400
       AND black_elo >= 2400
     ORDER BY id ASC
     LIMIT $1`,
    [flags.target * 5],
  );
  const allowedIds = new Set(filterRes.rows.map((r) => r.id));
  await filterPg.end();
  if (allowedIds.size === 0) {
    process.stderr.write('[batch] No matching games found, abort.\n');
    process.exit(1);
  }
  const sortedIds = Array.from(allowedIds).sort();
  const minId = sortedIds[0];
  const maxId = sortedIds[sortedIds.length - 1];
  process.stdout.write(
    `[batch] selected ${allowedIds.size} game(s) classical+both≥2400, ` +
      `minId=${minId} maxId=${maxId}\n`,
  );

  // ── 2. Поднимаем Nest application context. ───────────────────────
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  const prisma = app.get(PrismaService);
  const engine = app.get(StockfishService);

  // ── 3. Pipeline pgClient (отдельное соединение). ─────────────────
  const pipePg = new PgClient(
    buildArchivePgClientConfig(archiveUrl, process.env, undefined, (m) =>
      process.stderr.write(`[batch] WARN: ${m}\n`),
    ),
  );
  await pipePg.connect();

  // ── 4. Stream-write callback. ────────────────────────────────────
  const buffer = new Map<string, BufferEntry>();
  let candidatesSeen = 0;
  let droppedNotInAllowed = 0;
  let writes = 0;
  let upgrades = 0;

  const writeNewPuzzle = async (puzzle: PuzzleRecord): Promise<void> => {
    if (flags.dryRun) return;
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
      // KS-2762
      sourceWhiteElo: puzzle.sourceWhiteElo,
      sourceBlackElo: puzzle.sourceBlackElo,
    };
    await prisma.puzzle.create({ data });
  };

  const insertPuzzle = async (puzzle: PuzzleRecord): Promise<boolean> => {
    if (!allowedIds.has(puzzle.sourceId)) {
      droppedNotInAllowed++;
      return false;
    }
    candidatesSeen++;

    let bd = 0;
    try {
      const meta = JSON.parse(puzzle.sourceMetadata) as {
        blunderDelta?: number;
      };
      bd = meta.blunderDelta ?? 0;
    } catch {
      bd = 0;
    }

    const existing = buffer.get(puzzle.sourceId);
    if (!existing) {
      // первый кандидат для этой партии — INSERT
      try {
        await writeNewPuzzle(puzzle);
        buffer.set(puzzle.sourceId, {
          puzzle,
          dbId: puzzle.id,
          blunderDelta: bd,
        });
        writes++;
      } catch (e: unknown) {
        process.stderr.write(
          `[batch] write failed sourceId=${puzzle.sourceId.slice(0, 8)}: ${(e as Error).message}\n`,
        );
        return false;
      }
    } else if (bd > existing.blunderDelta) {
      // нашли лучше — DELETE старый + INSERT новый
      try {
        await prisma.puzzle.delete({ where: { id: existing.dbId } });
        await writeNewPuzzle(puzzle);
        buffer.set(puzzle.sourceId, {
          puzzle,
          dbId: puzzle.id,
          blunderDelta: bd,
        });
        upgrades++;
      } catch (e: unknown) {
        process.stderr.write(
          `[batch] upgrade failed sourceId=${puzzle.sourceId.slice(0, 8)}: ${(e as Error).message}\n`,
        );
      }
    }
    // прогресс — каждые 5 уникальных партий печатаем сводку
    if (buffer.size > 0 && buffer.size % 5 === 0) {
      process.stdout.write(
        `[batch] progress: uniqueGames=${buffer.size}/${flags.target} ` +
          `candidates=${candidatesSeen} writes=${writes} upgrades=${upgrades} ` +
          `droppedNotInAllowed=${droppedNotInAllowed}\n`,
      );
    }
    if (buffer.size >= flags.target) {
      // Early-exit: target достигнут.
      throw new EarlyExitSignal(buffer.size);
    }
    return true;
  };

  // SIGINT/SIGTERM — даём pipeline'у завершиться, но без cleanup'а.
  // Кандидаты уже в БД (stream-write).
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    process.stdout.write('\n[batch] SIGINT — будем выходить после текущей партии\n');
  });

  // ── 5. Pipeline options. ─────────────────────────────────────────
  // Cursor немного меньше minId, чтобы pipeline стартовал близко к
  // первому allowedId (UUID-ы в строковом порядке). minId без 1 в конце:
  // для UUID типа `0002b9c2-...` уменьшение «9» на «8» в конкретном
  // символе даст лексикографически меньший id. Самый надёжный
  // лексикографически меньший uuid: всё '0' (UUID nil).
  const cursor = '00000000-0000-0000-0000-000000000000';
  const baseOptions = defaultGeneratorOptions();
  const options: GeneratorOptions = {
    ...baseOptions,
    maxGames: 30000,
    blunderDelta: flags.blunderDelta,
    minRating: 2400,
    minPly: 20,
    startPly: 20,
    engineLimit: { depth: flags.depth },
    halfMovesN: 6,
    winThreshold: 0.5,
    failThreshold: 0.0,
    skipDecidedWdl: 0.95,
    minWdlAfterBlunder: 0.5,
    solutionMode: 'play-vs-engine',
    gameBatchSize: 200,
    cursor,
    insertPuzzle,
  };

  process.stdout.write(
    `[batch] starting pipeline cursor=${cursor.slice(0, 8)} ` +
      `maxGames=${options.maxGames}\n`,
  );

  let earlyExited = false;
  let stats;
  try {
    stats = await runPuzzleGenerator({
      pg: pipePg,
      engine,
      options,
    });
  } catch (e: unknown) {
    if (e instanceof EarlyExitSignal) {
      earlyExited = true;
      process.stdout.write(
        `[batch] early-exit: ${e.message} (target reached)\n`,
      );
    } else {
      throw e;
    }
  }

  if (interrupted) {
    process.stdout.write('[batch] interrupted by signal\n');
  }

  // ── 6. Отчёт. ────────────────────────────────────────────────────
  const buckets: Record<string, number> = {
    '0.6-0.9': 0,
    '0.9-1.2': 0,
    '1.2-1.5': 0,
    '>=1.5': 0,
  };
  for (const e of buffer.values()) {
    const bd = e.blunderDelta;
    if (bd >= 1.5) buckets['>=1.5']++;
    else if (bd >= 1.2) buckets['1.2-1.5']++;
    else if (bd >= 0.9) buckets['0.9-1.2']++;
    else buckets['0.6-0.9']++;
  }

  const samples = Array.from(buffer.values())
    .slice(0, 3)
    .map((e) => {
      let meta: {
        blunderMove?: string;
        wdlBeforeBlunder?: number;
        wdlAfterBlunder?: number;
        blunderDelta?: number;
      } = {};
      try {
        meta = JSON.parse(e.puzzle.sourceMetadata);
      } catch {
        /* keep empty */
      }
      return {
        puzzleId: e.puzzle.id,
        sourceId: e.puzzle.sourceId,
        ply: e.puzzle.sourceMoveNum,
        rating: e.puzzle.rating,
        fen: e.puzzle.fen,
        blunderMove: meta.blunderMove,
        wdlBefore: meta.wdlBeforeBlunder,
        wdlAfter: meta.wdlAfterBlunder,
        blunderDelta: meta.blunderDelta,
      };
    });

  const elapsedSec = (Date.now() - t0) / 1000;
  const processedGames = stats?.gamesProcessed ?? 0;
  const avgPerGameSec = processedGames > 0 ? elapsedSec / processedGames : 0;
  process.stdout.write(
    `\n[batch] === REPORT ===\n` +
      `target=${flags.target} ` +
      `processedGames=${processedGames} ` +
      `relevantSelected=${allowedIds.size} ` +
      `puzzleCandidatesSeen=${candidatesSeen} ` +
      `unique(=1 per game)=${buffer.size} ` +
      `writes=${writes} upgrades=${upgrades} ` +
      `earlyExited=${earlyExited} ` +
      `elapsedSec=${elapsedSec.toFixed(1)} ` +
      `avgPerGame=${avgPerGameSec.toFixed(2)}s\n` +
      `blunderDelta distribution: ${JSON.stringify(buckets)}\n` +
      `samples: ${JSON.stringify(samples, null, 2)}\n`,
  );

  await pipePg.end().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}

main().catch((e: unknown) => {
  process.stderr.write(`✗ batch fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
