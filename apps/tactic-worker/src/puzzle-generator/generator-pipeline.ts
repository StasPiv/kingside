/**
 * KS-2464 / ADR-044 §6. Puzzle-generator pipeline (play-vs-engine).
 *
 * Алгоритм:
 *   1. Идём по партиям из archive_games batch'ами.
 *   2. На каждой партии: проигрываем ходы chess.js. На ply >= startPly:
 *      a. analyzePositionWdl(fenBefore, multiPV=2) — лучший и второй
 *         ходы движка ДО хода партии.
 *      b. samePv1 — если ход партии совпал с PV1 → не зевок (drop).
 *      c. skipDecided — если |wdlBefore| > skipDecidedWdl → drop.
 *      d. Применяем ход. gameOver — если мат/пат/ничья → drop.
 *      e. analyzePositionWdl(fenAfter, multiPV=2). pv1 от лица решающей.
 *      f. blunderΔ = wdlBefore + pv1 (pv1 уже от противоположной стороны;
 *         сложение даёт величину «насколько хуже стало для сходившего»).
 *         Если blunderΔ < blunderDelta → drop (notBlunder).
 *      g. wdlAfter (для решающей) = pv1. Если < minWdlAfterBlunder →
 *         drop (lowWdlAfterBlunder).
 *      h. Solvability check: halfMovesN полуходов Stockfish-vs-Stockfish.
 *         На каждом ply решающей берём bestmove (multiPV=1). После
 *         каждого хода движка-противника считаем WDL для решающей.
 *         Если < failThreshold в любой момент — drop (solvabilityFailed).
 *         Через halfMovesN: если WDL ≥ winThreshold — пазл проходит.
 *   3. Tagging — drill-предикаты + алгоритмика, технический тег
 *      `playVsEngine`.
 *   4. Insert через callback, solutionMode='play-vs-engine', moves=''.
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
import type { MultiPvLine } from './types';
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

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;

    if (ply < options.startPly || replay.isGameOver()) {
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    // 1. Pre-analyze fenBefore.
    const fenBefore = replay.fen();
    let preBefore: MultiPvLine[];
    try {
      preBefore = await engine.analyzePositionWdl(
        fenBefore,
        options.engineLimit,
        2,
      );
    } catch {
      // Не считаем positionsAnalyzed (engine упал на пре-анализе).
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    if (preBefore.length === 0) {
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    const wdlBefore = wdlSignedFromInfo(
      preBefore[0].wdl,
      preBefore[0].score,
    );
    if (wdlBefore == null) {
      stats.positionsAnalyzed++;
      stats.drops.noScore++;
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    stats.positionsAnalyzed++;

    // 2. samePv1 — ход партии совпал с первой линией движка.
    const playedUci = `${m.from}${m.to}${m.promotion ?? ''}`;
    if (samePv1(playedUci, preBefore[0].bestMove)) {
      stats.drops.samePv1++;
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    // 3. skipDecided.
    if (Math.abs(wdlBefore) > options.skipDecidedWdl) {
      stats.drops.decided++;
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }

    // 4. Применяем ход.
    if (!(await applyOrReturn(replay, m))) return;

    if (replay.isGameOver()) {
      stats.drops.gameOver++;
      continue;
    }

    // 5. Post-analyze fenAfter (PV1 от лица решающей).
    const fenAfter = replay.fen();
    const solverSide = replay.turn() as 'w' | 'b';
    let postPvs: MultiPvLine[];
    try {
      postPvs = await engine.analyzePositionWdl(
        fenAfter,
        options.engineLimit,
        2,
      );
    } catch {
      stats.drops.engineError++;
      continue;
    }
    if (postPvs.length === 0) {
      stats.drops.engineError++;
      continue;
    }
    const wdlAfterForSolver = wdlSignedFromInfo(
      postPvs[0].wdl,
      postPvs[0].score,
    );
    if (wdlAfterForSolver == null) {
      stats.drops.noScore++;
      continue;
    }

    // 6. blunderΔ = wdlBefore + wdlAfterForSolver (одинаковая POV-логика
    // как в KS-2431 / cli/analyze-pgn).
    const blunderDelta = wdlBefore + wdlAfterForSolver;
    if (blunderDelta < options.blunderDelta) {
      stats.drops.notBlunder++;
      continue;
    }

    // 7. WDL после зевка должен быть достаточно высоким, иначе позиция
    // фактически не выигрывается явно.
    if (wdlAfterForSolver < options.minWdlAfterBlunder) {
      stats.drops.lowWdlAfterBlunder++;
      continue;
    }

    // 8. Solvability check.
    const firstMovePV1 = postPvs[0].bestMove;
    const solvable = await checkSolvability({
      engine,
      startFen: fenAfter,
      solverSide,
      halfMovesN: options.halfMovesN,
      winThreshold: options.winThreshold,
      failThreshold: options.failThreshold,
      limit: options.engineLimit,
    });
    if (!solvable) {
      stats.drops.solvabilityFailed++;
      continue;
    }

    // 9. Tagging.
    const tags = computeTags({
      startFen: fenAfter,
      moves: [firstMovePV1],
      finalCpForSolver: wdlToApproxCp(wdlAfterForSolver),
      endsInMate: false,
    });
    tags.push('playVsEngine');

    const rating = computeStartingRating(row, wdlAfterForSolver);
    const puzzle: PuzzleRecord = {
      id: randomUUID(),
      fen: fenAfter,
      moves: '',
      rating,
      ratingDev: 350,
      themes: Array.from(new Set(tags)).sort().join(' '),
      source: 'generated',
      sourceType: 'archive_game',
      sourceId: row.id,
      sourceMoveNum: ply,
      gap: Math.round(wdlAfterForSolver * 100),
      depth: options.engineLimit.depth ?? 0,
      isPublic: true,
      acceptedMoves: null,
      solutionMode: options.solutionMode,
      sourceMetadata: JSON.stringify({
        blunderMove: playedUci,
        wdlBeforeBlunder: round3(wdlBefore),
        wdlAfterBlunder: round3(wdlAfterForSolver),
        blunderDelta: round3(blunderDelta),
        firstMovePV1,
        winThreshold: options.winThreshold,
        failThreshold: options.failThreshold,
        halfMovesN: options.halfMovesN,
        engine: 'stockfish',
        engineParams: options.engineLimit,
        generatedAt: new Date().toISOString(),
      }),
    };

    let inserted = false;
    try {
      inserted = await options.insertPuzzle(puzzle);
    } catch {
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

export function samePv1(playedUci: string, pv1Uci: string): boolean {
  // Сравниваем from+to (4 символа). Promotion — отдельная буква (5-й
  // символ); оба варианта (`e7e8q` и `e7e8`) считаем совпадением
  // только если from+to + promotion идентичны. Если promotion в одном
  // присутствует, в другом нет — неполное совпадение, не считаем.
  if (!playedUci || !pv1Uci) return false;
  if (playedUci.length < 4 || pv1Uci.length < 4) return false;
  return playedUci.slice(0, 5) === pv1Uci.slice(0, 5);
}

interface SolvabilityArgs {
  engine: EngineApi;
  startFen: string;
  solverSide: 'w' | 'b';
  halfMovesN: number;
  winThreshold: number;
  failThreshold: number;
  limit: import('./types').AnalysisLimit;
}

/**
 * Проверка решаемости: halfMovesN полуходов Stockfish-vs-Stockfish из
 * `startFen`. На каждом ply берём bestmove. После каждого
 * полухода-противника проверяем WDL для решающей; если < failThreshold —
 * drop. По окончании halfMovesN — если WDL ≥ winThreshold, проходит.
 */
async function checkSolvability(args: SolvabilityArgs): Promise<boolean> {
  const { engine, startFen, solverSide, halfMovesN, winThreshold, failThreshold, limit } = args;
  const chess = new Chess(startFen);
  let lastWdlForSolver: number | null = null;

  for (let ply = 0; ply < halfMovesN; ply++) {
    if (chess.isGameOver()) {
      // Мат за решающую — пазл решаемый. Стейлмейт/ничья — провал.
      if (chess.isCheckmate()) {
        // Сторона, которая получила мат — проигравшая. Если это
        // противник решающей, мы выиграли.
        const losingSide = chess.turn() as 'w' | 'b';
        return losingSide !== solverSide;
      }
      return false;
    }
    let pvs: MultiPvLine[];
    try {
      pvs = await engine.analyzePositionWdl(chess.fen(), limit, 1);
    } catch {
      return false;
    }
    if (pvs.length === 0 || !pvs[0].bestMove) return false;
    const bm = pvs[0].bestMove;
    const wdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
    const sideToMove = chess.turn() as 'w' | 'b';
    // POV: WDL отдан от стороны на ходу.
    if (wdl != null) {
      lastWdlForSolver = sideToMove === solverSide ? wdl : -wdl;
      if (lastWdlForSolver < failThreshold) return false;
    }
    if (!applyUci(chess, bm)) return false;
  }

  // Финальная позиция — анализируем ещё раз для итогового WDL за
  // решающую (если последний ход был решающего, то после него
  // sideToMove = противник, и WDL от его лица; инвертируем).
  try {
    const finalPvs = await engine.analyzePositionWdl(chess.fen(), limit, 1);
    if (finalPvs.length > 0) {
      const w = wdlSignedFromInfo(finalPvs[0].wdl, finalPvs[0].score);
      if (w != null) {
        const sideToMove = chess.turn() as 'w' | 'b';
        lastWdlForSolver = sideToMove === solverSide ? w : -w;
      }
    }
  } catch {
    // Используем последний известный
  }

  return lastWdlForSolver != null && lastWdlForSolver >= winThreshold;
}

async function applyOrReturn(
  replay: Chess,
  m: { from: string; to: string; promotion?: string },
): Promise<boolean> {
  try {
    const made = replay.move({
      from: m.from,
      to: m.to,
      ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
    });
    return !!made;
  } catch {
    return false;
  }
}

function applyUci(chess: Chess, uci: string): boolean {
  if (uci.length < 4) return false;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion =
    uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
  try {
    const r = chess.move({
      from,
      to,
      ...(promotion ? { promotion } : {}),
    });
    return !!r;
  } catch {
    return false;
  }
}

function wdlToApproxCp(wdl: number): number {
  // Обратная формула lichess для качественной оценки. Используется
  // только для tagging crushing/advantage порогов.
  if (wdl >= 0.999) return 5000;
  if (wdl <= -0.999) return -5000;
  const k = 0.00368208;
  return Math.round(-Math.log((1 - wdl) / (1 + wdl)) / k);
}

function computeStartingRating(
  row: ArchiveGameRow,
  wdlAfterBlunder: number,
): number {
  const w = row.white_elo ?? 1500;
  const b = row.black_elo ?? 1500;
  const avg = Math.round((w + b) / 2);
  // Чем меньше преимущество после зевка, тем сложнее пазл (сложнее
  // удерживать). Шаг ±100 в диапазоне [600..2800].
  const wdlAdj = wdlAfterBlunder >= 0.85 ? -100 : wdlAfterBlunder < 0.6 ? 100 : 0;
  return Math.max(600, Math.min(2800, avg + wdlAdj));
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
    `samePv1=${stats.drops.samePv1} ` +
    `decided=${stats.drops.decided} ` +
    `gameOver=${stats.drops.gameOver} ` +
    `lowWdlAfterBlunder=${stats.drops.lowWdlAfterBlunder} ` +
    `solvabilityFailed=${stats.drops.solvabilityFailed} ` +
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
