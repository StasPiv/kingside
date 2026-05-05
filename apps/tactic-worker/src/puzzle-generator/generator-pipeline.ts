/**
 * KS-2431 / ADR-041. Puzzle-generator pipeline (этап 1 MVP).
 *
 * Высокоуровневый flow:
 *   1. Прочитать batch партий из `archive_games` через pg-клиент.
 *   2. Для каждой партии — пройти ходы, на каждом ply ≥ startPly:
 *      - до хода: analyze(depth) → bestScore + bestMove.
 *      - после хода: analyze(depth) → actualScore (eval позиции после
 *        сделанного хода).
 *      - evalDrop = bestCp(POV ходящего) − actualCp(POV того же).
 *      - Если evalDrop ≥ minEvalDrop → blunder-кандидат.
 *   3. На позиции после blunder: analyzeMultiPV → spread = lines[0] − lines[1]
 *      от лица стороны на ходу. Если spread ≥ minSpread → uniqueness.
 *   4. Отсев recapture (§2.5): если made-move был capture, а первый
 *      ход решения тоже capture на той же клетке — это recapture, drop.
 *   5. buildForcedLine(...) для линии 2..maxLineLength.
 *   6. tagging(startFen, moves, finalCp, endsInMate).
 *   7. Insert в `puzzles` через `insertPuzzle` callback.
 *
 * Pipeline принимает engine-интерфейс (моки для тестов) и
 * insertPuzzle callback (для тестов и для реального Prisma-writer'а
 * в CLI).
 */
import { Chess } from 'chess.js';
import type { Client as PgClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  type EngineApi,
  type GeneratorOptions,
  type GeneratorStats,
  type PuzzleRecord,
  newGeneratorStats,
} from './types';
import { cpFromSide, isMateScore } from './score';
import { isBlunder, isRecapture, isUnique } from './blunder-detection';
import { buildForcedLine } from './line-builder';
import { computeTags } from './tagging';

interface ArchiveGameRow {
  id: string;
  pgn: string;
  white_elo: number | null;
  black_elo: number | null;
  ply_count: number | null;
  time_control_category: string | null;
}

export interface RunArgs {
  pg: PgClient;
  engine: EngineApi;
  options: GeneratorOptions;
}

export async function runPuzzleGenerator(
  args: RunArgs,
): Promise<GeneratorStats> {
  const { pg, engine, options } = args;
  const log = options.log ?? ((l) => process.stdout.write(`${l}\n`));
  const stats = newGeneratorStats();
  let cursor: string | null = options.cursor ?? null;

  while (stats.gamesProcessed < options.maxGames) {
    const sql: string = cursor
      ? `SELECT id::text AS id, pgn, white_elo, black_elo, ply_count,
                time_control_category
         FROM archive_games
         WHERE id > $1 ORDER BY id ASC LIMIT $2`
      : `SELECT id::text AS id, pgn, white_elo, black_elo, ply_count,
                time_control_category
         FROM archive_games
         ORDER BY id ASC LIMIT $1`;
    const params: (string | number)[] = cursor
      ? [cursor, options.gameBatchSize]
      : [options.gameBatchSize];
    const res = await pg.query<ArchiveGameRow>(sql, params);
    const rows = res.rows;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    stats.lastCursor = cursor;

    for (const row of rows) {
      if (stats.gamesProcessed >= options.maxGames) break;
      stats.gamesProcessed++;

      // Фильтры партии (ADR-041 §2.3).
      if (!passesGameFilters(row, options)) continue;

      try {
        await processGame(row, engine, options, stats);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[puzzle-gen] WARN game=${row.id} skipped: ${msg}`);
      }

      if (stats.gamesProcessed % 10 === 0) {
        logProgress(stats, log);
      }
    }
  }

  logProgress(stats, log);
  return stats;
}

function passesGameFilters(
  row: ArchiveGameRow,
  options: GeneratorOptions,
): boolean {
  // Time control — bullet/unknown отсекаем; null допускаем (TWIC часто
  // не имеет это поле, и партии там качественные).
  const tc = row.time_control_category;
  if (tc && tc !== 'classical' && tc !== 'rapid' && tc !== 'blitz') {
    return false;
  }
  // Plycount.
  if (row.ply_count != null && row.ply_count < options.minPly) return false;
  // Min rating — допускаем null (TWIC часто без Elo).
  if (
    row.white_elo != null &&
    row.black_elo != null &&
    (row.white_elo < options.minRating || row.black_elo < options.minRating)
  ) {
    return false;
  }
  return true;
}

async function processGame(
  row: ArchiveGameRow,
  engine: EngineApi,
  options: GeneratorOptions,
  stats: GeneratorStats,
): Promise<void> {
  const chess = new Chess();
  try {
    chess.loadPgn(row.pgn);
  } catch {
    return;
  }
  const history = chess.history({ verbose: true });
  const replay = new Chess();

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    const fenBefore = replay.fen();
    const sideToMoveBefore = replay.turn() as 'w' | 'b';

    // Apply move to advance replay.
    let made;
    try {
      made = replay.move({
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion } : {}),
      });
    } catch {
      return;
    }
    if (!made) return;

    // Анализируем только ходы начиная с startPly.
    if (ply < options.startPly) continue;
    // Не анализируем последний ход партии (пустая позиция «после»
    // может содержать mate — туда уже не строим).
    if (replay.isGameOver()) continue;

    stats.positionsAnalyzed++;

    let bestBefore;
    let actualAfter;
    try {
      bestBefore = await engine.analyze(fenBefore, options.depth);
      actualAfter = await engine.analyze(replay.fen(), options.depth);
    } catch {
      // Engine timeout / spawn error — drop этот ply, продолжаем партию.
      continue;
    }
    if (!bestBefore.score || !actualAfter.score) continue;

    // evalDrop в POV сторонявший ход (sideToMoveBefore).
    // bestBefore.score — относительно sideToMoveBefore (он на ходу).
    // actualAfter.score — относительно стороны, которая теперь на ходу
    //   (это противник sideToMoveBefore).
    const bestCp = cpFromSide(
      bestBefore.score,
      sideToMoveBefore,
      sideToMoveBefore,
    );
    const actualCp = cpFromSide(
      actualAfter.score,
      sideToMoveBefore,
      replay.turn() as 'w' | 'b',
    );
    const evalDrop = bestCp - actualCp;

    if (!isBlunder(evalDrop, options.minEvalDrop)) {
      stats.drops.noBlunder++;
      continue;
    }

    // Стартовая позиция puzzle = replay.fen() (после blunder).
    // Сторона, решающая puzzle = replay.turn() (противник зевнувшего).
    const puzzleFen = replay.fen();
    const solverSide = replay.turn() as 'w' | 'b';

    // Uniqueness в стартовой позиции puzzle.
    let mpv;
    try {
      mpv = await engine.analyzeMultiPV(
        puzzleFen,
        options.depth,
        options.multiPV,
      );
    } catch {
      continue;
    }
    if (mpv.length < 1) continue;
    const bestSolver = cpFromSide(mpv[0].score, solverSide, solverSide);
    const secondSolver =
      mpv.length >= 2
        ? cpFromSide(mpv[1].score, solverSide, solverSide)
        : -Infinity;
    const spread = isMateScore(mpv[0].score)
      ? Number.MAX_SAFE_INTEGER
      : bestSolver - secondSolver;
    if (!isUnique(spread, options.minSpread)) {
      stats.drops.notUnique++;
      continue;
    }

    const firstMoveUci = mpv[0].bestMove;

    // Recapture-trash filter.
    if (isRecapture(made, firstMoveUci)) {
      stats.drops.recapture++;
      continue;
    }

    // Build forced line.
    const line = await buildForcedLine(puzzleFen, firstMoveUci, {
      engine,
      depth: options.depth,
      multiPV: options.multiPV,
      minSpread: options.minSpread,
      defenseSpread: 50, // ADR-041 §2.4 ±50cp
      maxLineLength: options.maxLineLength,
      solverSide,
    });

    if (line.moves.length < options.minLineLength) {
      stats.drops.tooShort++;
      continue;
    }
    if (line.moves.length > options.maxLineLength) {
      stats.drops.tooLong++;
      continue;
    }

    // Tagging.
    const tags = computeTags({
      startFen: puzzleFen,
      moves: line.moves,
      finalCpForSolver: line.finalCpForSolver,
      endsInMate: line.endsInMate,
    });

    // Rating (ADR-041 §3.6).
    const rating = computeStartingRating(row, line.moves.length, spread);

    const puzzle: PuzzleRecord = {
      id: randomUUID(),
      fen: puzzleFen,
      moves: line.moves.join(' '),
      rating,
      ratingDev: 350,
      themes: tags.join(' '),
      source: 'generated',
      sourceType: 'archive_game',
      sourceId: row.id,
      sourceMoveNum: ply, // ply, на котором был blunder
      gap: Math.round(Math.min(spread, 5000)),
      depth: options.depth,
      isPublic: true,
      acceptedMoves: line.acceptedMoves
        ? JSON.stringify(line.acceptedMoves)
        : null,
      sourceMetadata: JSON.stringify({
        evalDrop: Math.round(evalDrop),
        lineLength: line.moves.length,
        engine: 'stockfish',
        depth: options.depth,
        multiPV: options.multiPV,
        finalCpForSolver: Math.round(line.finalCpForSolver),
        endsInMate: line.endsInMate,
        generatedAt: new Date().toISOString(),
      }),
    };

    let inserted = false;
    try {
      inserted = await options.insertPuzzle(puzzle);
    } catch {
      // Insert errors считаем drop'ами (БД-уровневый conflict / timeout).
      stats.drops.duplicate++;
      continue;
    }
    if (!inserted) {
      stats.drops.duplicate++;
      continue;
    }

    stats.inserted++;
    for (const t of tags) {
      stats.tagDistribution[t] = (stats.tagDistribution[t] ?? 0) + 1;
    }
  }
}

function computeStartingRating(
  row: ArchiveGameRow,
  lineLength: number,
  spread: number,
): number {
  const w = row.white_elo ?? 1500;
  const b = row.black_elo ?? 1500;
  const avg = Math.round((w + b) / 2);
  const lengthAdj = (lineLength - 4) * 100;
  const gapAdj = spread > 400 ? -100 : spread < 200 ? 100 : 0;
  const raw = avg + lengthAdj + gapAdj;
  return Math.max(600, Math.min(2800, raw));
}

function logProgress(
  stats: GeneratorStats,
  log: (line: string) => void,
): void {
  const drops =
    `noBlunder=${stats.drops.noBlunder} ` +
    `notUnique=${stats.drops.notUnique} ` +
    `tooShort=${stats.drops.tooShort} ` +
    `tooLong=${stats.drops.tooLong} ` +
    `recapture=${stats.drops.recapture} ` +
    `duplicate=${stats.drops.duplicate}`;
  const tagsArr = Object.entries(stats.tagDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}:${v}`);
  log(
    `[puzzle-gen] games=${stats.gamesProcessed} ` +
      `analyzed=${stats.positionsAnalyzed} ` +
      `inserted=${stats.inserted} ` +
      `drops:{${drops}} ` +
      `tags:{${tagsArr.join(' ')}}`,
  );
}
