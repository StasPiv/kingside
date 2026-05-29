/**
 * KS-3158 / ADR-070 §2.4 — серверная обёртка над shared puzzle-gen-
 * pipeline. До этого тут был полный stage-based код (collect tasks →
 * Promise.all pre/post → evaluateBlunder → solvability). После S1
 * (KS-3157) shared берёт на себя replay PGN, evaluateBlunder и
 * построение пазлов; здесь — только I/O (БД-выборка, Stockfish-pool,
 * insert) + server-specific augmentation (drill-tags, rating, gap,
 * dump-buffer).
 *
 * Server settings (`SERVER_MIN_PLAYER_ELO = 2400`, обе фазы emit) —
 * константы релиза, не из ENV. CLI-флаг `--min-rating` оставлен как
 * deprecated алиас для backward-compat (см. KS-2776 и т.п. крон-
 * скрипты), мапится на `options.minRating` → `settings.minPlayerElo`.
 *
 * Параллелизм:
 *   - между партиями — `GAME_CONCURRENCY` (env, default 8);
 *   - внутри партии — `Promise.all(steps.map(analyzePlyForBlunder))`,
 *     Stockfish-pool сам сериализует SF-вызовы по STOCKFISH_POOL_SIZE.
 */
import type { Client as PgClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  type EngineApi,
  type GeneratorOptions,
  type GeneratorStats,
  type MultiPvLine,
  type PuzzleRecord,
  newGeneratorStats,
} from './types';
import {
  analyzePlyForBlunder,
  buildPuzzlesFromCandidate,
  passesPlayerEloFilter,
  replayPgnToSteps,
  type AnalyzePlyRejectReason,
  type BlunderCandidate,
  type GameMeta,
  type PuzzleGenEngine,
  type PuzzleGenSettings,
  type Wdl,
  wdlSigned,
} from '@kingside/shared';
import { computeTags } from './tagging';

/**
 * KS-3136 / ADR-068 §1.2 + KS-3140: пороги дельт и after-фильтр —
 * hardcoded в серверной обёртке (клиент перетирает через PUZZLE_GEN_
 * DEFAULTS / user-controls).
 */
const HARD_DELTA_W = 0.6;
const HARD_DELTA_D = 0.6;
const HARD_MIN_WD_AFTER = 0.5;

/**
 * KS-3158 / ADR-070 §2.2: серверный фильтр TWIC по Elo обоих игроков.
 * Поднятый default в `defaultGeneratorOptions.minRating` — 2400.
 * CLI-флаг `--min-rating=N` переопределяет (для дебага / локальных
 * прогонов).
 */
const SERVER_MIN_PLAYER_ELO = 2400;

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

  // KS-2470: параллелизм между партиями. GAME_CONCURRENCY env (default 8).
  const gameConcurrency = Math.max(
    1,
    Number(process.env.GAME_CONCURRENCY ?? 8) || 8,
  );

  // KS-2776: динамическая сборка WHERE — cursor + import_id + exclude.
  const excludeGameIds = options.excludeGameIds ?? [];
  while (stats.gamesProcessed < options.maxGames) {
    const conds: string[] = [];
    const params: (string | number | string[])[] = [];
    let idx = 1;
    if (cursor) {
      conds.push(`id > $${idx++}`);
      params.push(cursor);
    }
    if (options.importId) {
      conds.push(`import_id = $${idx++}`);
      params.push(options.importId);
    }
    if (excludeGameIds.length > 0) {
      conds.push(`NOT (id = ANY($${idx++}::uuid[]))`);
      params.push(excludeGameIds);
    }
    // KS-3396. Горизонтальный шардинг: при shardCount>1 берём только
    // партии своего шарда. `hashtext(id::text)` — встроенный PG-хэш
    // (int4, может быть отрицательным); `(% N + N) % N` даёт остаток
    // в [0..N-1] независимо от знака → равномерное непересекающееся
    // разбиение. Объединение шардов 0..N-1 = вся база, пересечений нет.
    if (
      options.shardCount != null &&
      options.shardCount > 1 &&
      options.shardIndex != null
    ) {
      const nParam = idx++;
      const iParam = idx++;
      conds.push(
        `((hashtext(id::text) % $${nParam}) + $${nParam}) % $${nParam} = $${iParam}`,
      );
      params.push(options.shardCount, options.shardIndex);
    }
    const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limitParam = idx++;
    params.push(options.gameBatchSize);
    const sql = `SELECT id::text AS id, pgn, white_elo, black_elo, ply_count,
                        time_control_category
                 FROM archive_games
                 ${whereClause}
                 ORDER BY id ASC LIMIT $${limitParam}`;
    const res = await pg.query<ArchiveGameRow>(sql, params);
    const rows = res.rows;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    stats.lastCursor = cursor;

    const remaining = options.maxGames - stats.gamesProcessed;
    const slice = rows.slice(0, Math.max(0, remaining));
    if (slice.length === 0) break;

    let nextIdx = 0;
    const workerCount = Math.min(gameConcurrency, slice.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= slice.length) return;
          const row = slice[idx];
          stats.gamesProcessed++;
          if (!passesGameFilters(row, options)) continue;
          // KS-3158 / ADR-070 §2.2: Elo-фильтр через shared. Партия
          // отбрасывается ДО replay, чтобы не тратить CPU на parse и
          // не тратить SF-tax. Default minRating = 2400 (см.
          // SERVER_MIN_PLAYER_ELO в defaults). 0 = пропускаем всех
          // (debug-режим, --min-rating=0).
          if (
            !passesPlayerEloFilter(
              row.white_elo,
              row.black_elo,
              options.minRating,
            )
          ) {
            stats.skippedByEloFilter++;
            continue;
          }
          try {
            await processGame(row, engine, options, stats);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[puzzle-gen] WARN game=${row.id} skipped: ${msg}`);
          }
          if (stats.gamesProcessed % 5 === 0) logProgress(stats, log);
        }
      }),
    );
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
  // KS-2697: ENV-узкий список time-control категорий (CSV).
  const allowedTcEnv = process.env.PUZZLE_GEN_TIME_CONTROL;
  if (allowedTcEnv) {
    const allowed = allowedTcEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0 && (!tc || !allowed.includes(tc))) {
      return false;
    }
  }
  if (row.ply_count != null && row.ply_count < options.minPly) return false;
  // KS-3158: Elo-фильтр унесён выше (passesPlayerEloFilter в shared).
  return true;
}

/**
 * Adapter: server-`EngineApi` → shared-`PuzzleGenEngine`. Маппинг полей
 * MultiPvLine → SharedMultiPvLine структурно совместим (bestMove +
 * score + wdl). Label обогащается game-id для phase-логов Stockfish.
 */
function makeServerEngineAdapter(
  engine: EngineApi,
  gameId: string,
  limit: import('./types').AnalysisLimit,
): PuzzleGenEngine {
  return {
    analyze: async (fen, multiPV, ctx) => {
      const label = ctx?.label
        ? `g=${gameId} ${ctx.label}`
        : `g=${gameId}`;
      // MultiPvLine содержит все поля SharedMultiPvLine — структурно
      // совместимый возврат через сужающий map.
      const lines = await engine.analyzePositionWdl(fen, limit, multiPV, label);
      return lines.map((l: MultiPvLine) => ({
        bestMove: l.bestMove,
        score: l.score,
        wdl: l.wdl,
      }));
    },
  };
}

async function processGame(
  row: ArchiveGameRow,
  engine: EngineApi,
  options: GeneratorOptions,
  stats: GeneratorStats,
): Promise<void> {
  // Replay PGN — отдаёт steps + headers (chess.js getHeaders в shared).
  const replay = replayPgnToSteps(row.pgn, options.startPly);
  if ('error' in replay) {
    stats.drops.engineError++;
    return;
  }
  if (replay.steps.length === 0) return;

  const headers = pickPgnHeaders(replay.headers);
  const gameMeta: GameMeta = {
    sourceType: 'archive_game',
    sourceId: row.id,
    whiteElo: row.white_elo,
    blackElo: row.black_elo,
    headers,
  };

  const settings: PuzzleGenSettings = {
    deltaWThreshold: HARD_DELTA_W,
    deltaDThreshold: HARD_DELTA_D,
    minWPlusDAfterForSolver: HARD_MIN_WD_AFTER,
    minPlayerElo: options.minRating,
    startPly: options.startPly,
    emitPreventivePuzzle: true,
    emitReactivePuzzle: true,
  };

  const adapterEngine = makeServerEngineAdapter(engine, row.id, options.engineLimit);

  // Параллельный анализ ply внутри партии. Каждый ply делает 2 SF-вызова
  // (pre+post) внутри shared. STOCKFISH_POOL_SIZE сам ограничит реальную
  // конкуррентность; Promise.all позволяет насытить пул.
  const results = await Promise.all(
    replay.steps.map((step) => analyzePlyForBlunder(step, adapterEngine, settings)),
  );

  for (let i = 0; i < replay.steps.length; i++) {
    const r = results[i];
    if (r.kind === 'rejected') {
      // engineError на pre-стадии: shared не отдаёт wdlBefore — позицию
      // не считаем "проанализированной". Для других reason'ов — считаем.
      if (r.reason !== 'engineError') {
        stats.positionsAnalyzed++;
      }
      bumpDrop(stats, r.reason);
      continue;
    }
    stats.positionsAnalyzed++;

    const puzzles = buildPuzzlesFromCandidate(r.candidate, gameMeta, settings);
    for (const gen of puzzles) {
      const record = adaptGeneratedPuzzleToRecord(
        gen,
        r.candidate,
        row,
        options,
      );
      let inserted = false;
      try {
        inserted = await options.insertPuzzle(record);
      } catch {
        stats.drops.duplicate++;
        continue;
      }
      if (!inserted) {
        stats.drops.duplicate++;
        continue;
      }
      stats.inserted++;
      for (const t of record.themes.split(' ')) {
        if (!t) continue;
        stats.tagDistribution[t] = (stats.tagDistribution[t] ?? 0) + 1;
      }
    }
  }
}

/**
 * Преобразование абстрактного GeneratedPuzzle из shared → server-specific
 * PuzzleRecord. Добавляет drill-теги (computeTags), gap, rating, server-
 * specific metadata-поля (winThreshold/failThreshold/engine из options).
 */
function adaptGeneratedPuzzleToRecord(
  gen: import('@kingside/shared').GeneratedPuzzle,
  candidate: BlunderCandidate,
  row: ArchiveGameRow,
  options: GeneratorOptions,
): PuzzleRecord {
  // Какое WDL фигурирует на стартовой позиции пазла (для gap/rating):
  // reactive — fenAfter (POV solver = противник), preventive — fenBefore
  // (POV solver = зевнувший, у которого до зевка ещё была хорошая позиция).
  const wdlAtStart: Wdl =
    gen.puzzlePhase === 'reactive'
      ? candidate.wdlAfterRaw
      : candidate.wdlBeforeRaw;
  const wdlSignedAtStart = wdlSigned(wdlAtStart);

  // Первый ход решения — для tagging-движка. Реактив: PV1 на fenAfter.
  // Превентив: PV1 на fenBefore (правильный ход, который надо найти
  // вместо зевка).
  const firstMoveUci =
    gen.puzzlePhase === 'reactive'
      ? candidate.firstMoveAfterUci
      : candidate.pv1BeforeUci;

  const drillTags = computeTags({
    startFen: gen.fen,
    moves: [firstMoveUci],
    finalCpForSolver: wdlToApproxCp(wdlSignedAtStart),
    endsInMate: false,
  });

  // Объединяем теги от shared (playVsEngine + objective + phase) и
  // drill-теги (pin/fork/crushing/...). Сортируем для детерминизма
  // в snapshot-тестах /precision.
  const allThemes = Array.from(new Set([...gen.themes, ...drillTags])).sort();

  const rating = computeStartingRating(row, wdlSignedAtStart);

  // sourceMetadata — на shared-base накладываем server-specific поля
  // (engine-config, generatedAt, halfMovesN/win/fail-threshold для
  // backward-compat с прежним JSON-шейпом, который читают API и UI).
  const sharedMeta = gen.sourceMetadata;
  const sourceMetadata: Record<string, unknown> = {
    ...sharedMeta,
    firstMovePV1: firstMoveUci,
    halfMovesN: options.halfMovesN,
    winThreshold: options.winThreshold,
    failThreshold: options.failThreshold,
    engine: 'stockfish',
    engineParams: options.engineLimit,
    generatedAt: new Date().toISOString(),
  };

  return {
    id: randomUUID(),
    fen: gen.fen,
    moves: '',
    rating,
    ratingDev: 350,
    themes: allThemes.join(' '),
    source: 'generated',
    sourceType: 'archive_game',
    sourceId: row.id,
    sourceMoveNum: gen.sourceMoveNum,
    gap: Math.round(wdlSignedAtStart * 100),
    depth: options.engineLimit.depth ?? 0,
    isPublic: true,
    acceptedMoves: null,
    solutionMode: options.solutionMode,
    sourceWhiteElo: row.white_elo,
    sourceBlackElo: row.black_elo,
    sourceMetadata: JSON.stringify(sourceMetadata),
  };
}

function bumpDrop(stats: GeneratorStats, reason: AnalyzePlyRejectReason): void {
  switch (reason) {
    case 'samePv1':
      stats.drops.samePv1++;
      break;
    case 'gameOver':
      stats.drops.gameOver++;
      break;
    case 'noScore':
      stats.drops.noScore++;
      break;
    case 'engineError':
      stats.drops.engineError++;
      break;
    case 'notBlunder':
      stats.drops.notBlunder++;
      break;
    case 'lowWplusDAfter':
      stats.drops.lowWplusDAfter++;
      break;
  }
}

/**
 * KS-2489. Whitelist ключей PGN-headers, которые попадают в
 * `puzzle.sourceMetadata.headers` для UI «Из партии».
 */
export function pickPgnHeaders(
  raw: Record<string, string | undefined>,
): Record<string, string> {
  const KEYS = [
    'White',
    'Black',
    'Event',
    'Date',
    'Site',
    'Round',
    'Result',
    'WhiteElo',
    'BlackElo',
  ] as const;
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      out[k] = v.trim();
    }
  }
  return out;
}

/**
 * Реэкспорт для тестов: точно та же реализация, что в shared. Оставлен
 * чтобы не ломать существующие spec-импорты.
 */
export { samePv1 } from '@kingside/shared';

function wdlToApproxCp(wdl: number): number {
  // Обратная формула lichess для оценочной cp — нужна tagging-pipeline'у
  // для crushing/advantage порогов.
  if (wdl >= 0.999) return 5000;
  if (wdl <= -0.999) return -5000;
  const k = 0.00368208;
  return Math.round(-Math.log((1 - wdl) / (1 + wdl)) / k);
}

function computeStartingRating(
  row: ArchiveGameRow,
  wdlAtStart: number,
): number {
  const w = row.white_elo ?? 1500;
  const b = row.black_elo ?? 1500;
  const avg = Math.round((w + b) / 2);
  // Шаг ±100 в [600..2800]: чем меньше |WDL| (сложнее реализация/
  // удержание), тем выше рейтинг.
  const abs = Math.abs(wdlAtStart);
  const wdlAdj = abs >= 0.85 ? -100 : abs < 0.6 ? 100 : 0;
  return Math.max(600, Math.min(2800, avg + wdlAdj));
}

function logProgress(
  stats: GeneratorStats,
  log: (line: string) => void,
): void {
  const drops =
    `notBlunder=${stats.drops.notBlunder} ` +
    `samePv1=${stats.drops.samePv1} ` +
    `gameOver=${stats.drops.gameOver} ` +
    `lowWplusDAfter=${stats.drops.lowWplusDAfter} ` +
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
      `skippedByEloFilter=${stats.skippedByEloFilter} ` +
      `accountedFor=${accountedFor} ` +
      `inserted=${stats.inserted} ` +
      `drops:{${drops}} ` +
      `tags:{${tagsArr.join(' ')}}`,
  );
}

// SERVER_MIN_PLAYER_ELO экспортируется для тестов и для документации
// конфига; в коде используется через `options.minRating` (=defaults
// сейчас 2400). CLI-override `--min-rating=N` остаётся для дебага.
export { SERVER_MIN_PLAYER_ELO };
