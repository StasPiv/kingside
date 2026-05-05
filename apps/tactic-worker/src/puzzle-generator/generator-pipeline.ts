/**
 * KS-2431 (WDL pivot). Puzzle-generator pipeline.
 *
 * Алгоритм:
 *   1. Идём по партиям из archive_games batch'ами.
 *   2. На каждой партии: проигрываем ходы chess.js. На ply >= startPly
 *      на каждой позиции делаем engine.analyzePositionWdl(fen, limit, 2).
 *   3. Для каждой пары `(prev_wdl, current_wdl_pv1)`:
 *      - prev_wdl — WDL_signed от лица той стороны, что сейчас на ходу
 *        (т.е. от лица сходившего ДО хода).
 *      - current_wdl от лица новой стороны (после хода) → инвертируем
 *        для сходившего: `-curWdlPv1`.
 *      - blunderDelta = prev_wdl - (-curWdlPv1) — насколько ход
 *        ухудшил WDL для сходившего. Положительное → плохой ход.
 *      - spread = curWdlPv1 - curWdlPv2 (от лица решающей, она же
 *        новая side-to-move).
 *   4. Принимаем кандидата если blunderDelta >= X И spread >= Y.
 *   5. Строим линию через buildForcedLine (на каждом нашем ходу snova
 *      проверяем spread).
 *   6. Tagging как раньше.
 *   7. Insert через callback.
 *
 * Между ply: prev_wdl обновляется как WDL_signed новой текущей
 * позиции от лица side-to-move (это уже посчитано при analyze).
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
import { wdlSignedFromInfo } from './score';
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
         FROM archive_games WHERE id > $1
         ORDER BY id ASC LIMIT $2`
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
      if (!passesGameFilters(row, options)) continue;
      try {
        await processGame(row, engine, options, stats);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[puzzle-gen] WARN game=${row.id} skipped: ${msg}`);
      }
      if (stats.gamesProcessed % 5 === 0) logProgress(stats, log);
    }
  }

  logProgress(stats, log);
  return stats;
}

function passesGameFilters(
  row: ArchiveGameRow,
  options: GeneratorOptions,
): boolean {
  const tc = row.time_control_category;
  if (tc && tc !== 'classical' && tc !== 'rapid' && tc !== 'blitz') {
    return false;
  }
  if (row.ply_count != null && row.ply_count < options.minPly) return false;
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

  // prev_wdl: WDL_signed от лица side-to-move в TEKUSHEY позиции
  // (которая будет ДО следующего хода). Стартовая позиция: equal,
  // прогноз "side has slight white advantage" — пусть будет 0.
  let prev_wdl: number | null = null;

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    const sideToMoveBefore = replay.turn() as 'w' | 'b';

    // Перед применением хода: если у нас ещё нет prev_wdl — анализируем
    // текущую позицию (до хода ply).
    if (prev_wdl == null && ply >= options.startPly) {
      try {
        const pvs = await engine.analyzePositionWdl(
          replay.fen(),
          options.engineLimit,
          1,
        );
        if (pvs.length > 0) {
          prev_wdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
        }
      } catch {
        /* no-op, prev_wdl останется null */
      }
    }

    // Применяем ход партии.
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

    if (ply < options.startPly) continue;
    if (replay.isGameOver()) continue;
    if (prev_wdl == null) continue; // нет основания для дельты

    stats.positionsAnalyzed++;

    // Анализируем позицию ПОСЛЕ хода (стартовая позиция кандидата).
    let pvs;
    try {
      pvs = await engine.analyzePositionWdl(
        replay.fen(),
        options.engineLimit,
        2,
      );
    } catch {
      stats.drops.engineError++;
      // Сбросим prev — следующий ply пересчитает с нуля.
      prev_wdl = null;
      continue;
    }
    if (pvs.length === 0) {
      stats.drops.engineError++;
      prev_wdl = null;
      continue;
    }
    const pv1Wdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
    const pv2Wdl =
      pvs.length >= 2
        ? wdlSignedFromInfo(pvs[1].wdl, pvs[1].score)
        : null;
    if (pv1Wdl == null) {
      stats.drops.noScore++;
      prev_wdl = null;
      continue;
    }

    // ΔWDL_зевка от лица сходившего: ход хуже если сходивший стал
    // оцениваться ниже, чем был до хода.
    // После хода новая side = противник sideToMoveBefore. WDL_PV1 от
    // лица новой = pv1Wdl. От лица сходившего = -pv1Wdl.
    const wdlAfterForMover = -pv1Wdl;
    const blunderDelta = prev_wdl - wdlAfterForMover;
    // spread на стартовой позиции puzzle'а (от лица решающей =
    // новой side-to-move).
    const spread =
      pv2Wdl != null ? pv1Wdl - pv2Wdl : Number.POSITIVE_INFINITY;

    // Подготовим prev для следующего ply (мы только что применили
    // ход, теперь side ходит, и pv1Wdl = WDL для неё; это и есть
    // prev для следующей итерации).
    const nextPrev = pv1Wdl;

    // Триггер X.
    if (blunderDelta < options.blunderDelta) {
      stats.drops.notBlunder++;
      prev_wdl = nextPrev;
      continue;
    }
    // Триггер Y.
    if (spread < options.spreadDelta) {
      stats.drops.notUnique++;
      prev_wdl = nextPrev;
      continue;
    }

    const puzzleFen = replay.fen();
    const solverSide = replay.turn() as 'w' | 'b';
    const firstMoveUci = pvs[0].bestMove;

    // Линия.
    const line = await buildForcedLine(puzzleFen, firstMoveUci, {
      engine,
      limit: options.engineLimit,
      spreadDelta: options.spreadDelta,
      maxLineLength: options.maxLineLength,
      solverSide,
    });
    if (line.moves.length < options.minLineLength) {
      stats.drops.tooShort++;
      prev_wdl = nextPrev;
      continue;
    }
    if (line.moves.length > options.maxLineLength) {
      stats.drops.tooLong++;
      prev_wdl = nextPrev;
      continue;
    }

    // Tagging.
    const tags = computeTags({
      startFen: puzzleFen,
      moves: line.moves,
      // tagging.ts ожидает finalCpForSolver в cp; конвертируем WDL_signed
      // в условные cp по обратной формуле lichess (только для тегов
      // crushing/advantage; не критично, точность необязательна).
      finalCpForSolver: wdlToApproxCp(line.finalWdlForSolver),
      endsInMate: line.endsInMate,
    });

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
      sourceMoveNum: ply,
      gap: Math.round(spread * 100), // целое в процентных пунктах WDL
      depth: options.engineLimit.depth ?? 0,
      isPublic: true,
      acceptedMoves: null,
      sourceMetadata: JSON.stringify({
        prevWdl: round3(prev_wdl),
        wdlAfterForMover: round3(wdlAfterForMover),
        blunderDelta: round3(blunderDelta),
        spreadDelta: round3(spread),
        pv1Wdl: round3(pv1Wdl),
        pv2Wdl: pv2Wdl != null ? round3(pv2Wdl) : null,
        finalWdlForSolver: round3(line.finalWdlForSolver),
        lineLength: line.moves.length,
        endsInMate: line.endsInMate,
        engineLimit: options.engineLimit,
        engine: 'stockfish',
        generatedAt: new Date().toISOString(),
      }),
    };

    let inserted = false;
    try {
      inserted = await options.insertPuzzle(puzzle);
    } catch {
      stats.drops.duplicate++;
      prev_wdl = nextPrev;
      continue;
    }
    if (!inserted) {
      stats.drops.duplicate++;
      prev_wdl = nextPrev;
      continue;
    }
    stats.inserted++;
    for (const t of tags) {
      stats.tagDistribution[t] = (stats.tagDistribution[t] ?? 0) + 1;
    }
    prev_wdl = nextPrev;
  }
}

function wdlToApproxCp(wdl: number): number {
  // Обратная формула lichess для качественной оценки. Результат
  // используется только для tagging crushing/advantage порогов.
  // |wdl| близко к 1 → большие cp. Без exp при граничных.
  if (wdl >= 0.999) return 5000;
  if (wdl <= -0.999) return -5000;
  // 2/(1+exp(-k·cp))-1 = wdl → cp = -ln((1-wdl)/(1+wdl)) / k.
  const k = 0.00368208;
  return Math.round(-Math.log((1 - wdl) / (1 + wdl)) / k);
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
  // gapAdj по spread WDL: большой spread (>0.5) — задача проще → −100;
  // маленький (<0.3) — сложнее → +100.
  const gapAdj = spread > 0.5 ? -100 : spread < 0.3 ? 100 : 0;
  return Math.max(600, Math.min(2800, avg + lengthAdj + gapAdj));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function logProgress(
  stats: GeneratorStats,
  log: (line: string) => void,
): void {
  const drops =
    `notBlunder=${stats.drops.notBlunder} ` +
    `notUnique=${stats.drops.notUnique} ` +
    `tooShort=${stats.drops.tooShort} ` +
    `tooLong=${stats.drops.tooLong} ` +
    `duplicate=${stats.drops.duplicate} ` +
    `noScore=${stats.drops.noScore} ` +
    `engineError=${stats.drops.engineError}`;
  const sumDrops = Object.values(stats.drops).reduce((a, b) => a + b, 0);
  const accountedFor = stats.inserted + sumDrops;
  const tagsArr = Object.entries(stats.tagDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k}:${v}`);
  log(
    `[puzzle-gen] games=${stats.gamesProcessed} ` +
      `analyzed=${stats.positionsAnalyzed} ` +
      `accountedFor=${accountedFor} ` +
      `inserted=${stats.inserted} ` +
      `drops:{${drops}} ` +
      `tags:{${tagsArr.join(' ')}}`,
  );
}
