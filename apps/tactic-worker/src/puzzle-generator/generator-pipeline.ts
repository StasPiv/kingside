/**
 * KS-2464 / ADR-044 §6. Puzzle-generator pipeline (play-vs-engine).
 *
 * KS-2470: восстановлен параллелизм Stockfish-pool. До этого фикса
 * каждая позиция партии анализировалась последовательно (`for await`
 * блокировал пул), фактически работал 1 worker из 5. Теперь:
 *   - партии параллелятся через GAME_CONCURRENCY (env, default 8);
 *   - внутри партии: stage-based, как в `analyze-pgn.cli.ts`:
 *     1) collect tasks (replay, синхронно);
 *     2) Promise.all всех fenBefore (multiPV=2);
 *     3) фильтры samePv1/skipDecided/gameOver — без движка;
 *     4) Promise.all всех fenAfter оставшихся (multiPV=2);
 *     5) blunderΔ + lowWdlAfterBlunder — без движка;
 *     6) solvability check — Promise.all между кандидатами,
 *        внутри одного кандидата последовательно по halfMovesN.
 *
 * Алгоритм фильтров не изменился (см. ADR-044 §6):
 *   a. samePv1 — ход партии = PV1 движка → drop.
 *   b. skipDecided — |wdlBefore| > skipDecidedWdl → drop.
 *   c. gameOver — позиция терминальная после хода → drop.
 *   d. blunderΔ = wdlBefore + wdlAfterForSolver. Если < blunderDelta → drop.
 *   e. wdlAfterForSolver < minWdlAfterBlunder → drop.
 *   f. Solvability: halfMovesN полуходов Stockfish-vs-Stockfish. WDL
 *      решающей < failThreshold в любой момент → drop. Через halfMovesN:
 *      WDL ≥ winThreshold — пазл проходит.
 *
 * Tagging — drill-предикаты + алгоритмика + технический тег `playVsEngine`.
 * Insert через callback, solutionMode='play-vs-engine', moves=''.
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
import { wdlSignedFromInfo, type Wdl } from './score';
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

  // KS-2470: параллелизм между партиями. GAME_CONCURRENCY env (default 8).
  // Воркер-pool сам сериализует SF-вызовы по STOCKFISH_POOL_SIZE.
  const gameConcurrency = Math.max(
    1,
    Number(process.env.GAME_CONCURRENCY ?? 8) || 8,
  );

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

    // Лимитируем — нельзя выйти за maxGames.
    const remaining = options.maxGames - stats.gamesProcessed;
    const slice = rows.slice(0, Math.max(0, remaining));
    if (slice.length === 0) break;

    // Параллельный пул воркеров над одной выборкой партий.
    let nextIdx = 0;
    const workerCount = Math.min(gameConcurrency, slice.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= slice.length) return;
          const row = slice[idx];
          // gamesProcessed увеличиваем сразу, чтобы logProgress видел темп.
          stats.gamesProcessed++;
          if (!passesGameFilters(row, options)) continue;
          try {
            await processGame(row, engine, options, stats);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[puzzle-gen] WARN game=${row.id} skipped: ${msg}`);
          }
          // Лог прогресса — без жёсткой кратности 5 (партии завершаются
          // одновременно из-за параллелизма; печатаем каждые 5 ОТНОСИТЕЛЬНО
          // последнего видимого значения).
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
  // По умолчанию pipeline принимает classical/rapid/blitz — но для
  // /precision генератора нужно ограничить classical-only без
  // изменений алгоритма. Пример: PUZZLE_GEN_TIME_CONTROL=classical.
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
  if (
    row.white_elo != null &&
    row.black_elo != null &&
    (row.white_elo < options.minRating || row.black_elo < options.minRating)
  ) {
    return false;
  }
  return true;
}

interface PlyTask {
  ply: number;
  m: { from: string; to: string; promotion?: string; san: string };
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  isGameOverAfter: boolean;
  solverSide: 'w' | 'b';
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
  // KS-2489: PGN headers партии — нужны фронту (KS-2487/2488) для блока
  // «Из партии: White vs Black, Event, Date». Извлекаем сразу после
  // loadPgn, потом вкладываем в `puzzle.sourceMetadata.headers`.
  const headers = pickPgnHeaders(chess.getHeaders() ?? {});
  const history = chess.history({ verbose: true });

  // ── Pass 1 (sync): replay + сбор задач ──────────────────────────
  // Идём по партии, на каждом ply ≥ startPly запоминаем fenBefore/fenAfter
  // + playedUci. Если позиция терминальная после хода — сразу учитываем
  // gameOver, без анализа.
  const replay = new Chess();
  const tasks: PlyTask[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    if (ply < options.startPly || replay.isGameOver()) {
      if (!(await applyOrReturn(replay, m))) return;
      continue;
    }
    const fenBefore = replay.fen();
    const playedUci = `${m.from}${m.to}${m.promotion ?? ''}`;
    if (!(await applyOrReturn(replay, m))) return;
    const fenAfter = replay.fen();
    const isGameOverAfter = replay.isGameOver();
    tasks.push({
      ply,
      m,
      fenBefore,
      fenAfter,
      playedUci,
      isGameOverAfter,
      solverSide: replay.turn() as 'w' | 'b',
    });
  }
  if (tasks.length === 0) return;

  // ── Stage 1 (parallel): pre-analyze всех fenBefore ──────────────
  // Уникальные FEN'ы (на случай повторов в партии — крайне редко).
  const fenBeforeSet = Array.from(new Set(tasks.map((t) => t.fenBefore)));
  const preMap = new Map<string, MultiPvLine[]>();
  await Promise.all(
    fenBeforeSet.map(async (fen) => {
      try {
        const pvs = await engine.analyzePositionWdl(
          fen,
          options.engineLimit,
          2,
          `g=${row.id} phase=analyze stage=pre`,
        );
        preMap.set(fen, pvs);
      } catch {
        preMap.set(fen, []);
      }
    }),
  );

  // ── Stage 2 (sync): samePv1 / skipDecided / engineError / gameOver ─
  // Отбираем кандидатов, для которых нужен post-analyze.
  interface PostCandidate {
    task: PlyTask;
    wdlBefore: number;
    /**
     * KS-2523: полный Wdl-объект (per-mille от Stockfish, POV side-to-
     * move в `fenBefore` = блундёр). null если Stockfish WDL не
     * вернул (старые версии при mate); в metadata тогда не пишется.
     */
    wdlBeforeRaw: Wdl | null;
    pv1Before: string;
  }
  const postCandidates: PostCandidate[] = [];
  for (const t of tasks) {
    const pre = preMap.get(t.fenBefore) ?? [];
    if (pre.length === 0) {
      // pre упал — не считаем positionsAnalyzed (как в старой логике).
      continue;
    }
    const wdlBefore = wdlSignedFromInfo(pre[0].wdl, pre[0].score);
    if (wdlBefore == null) {
      stats.positionsAnalyzed++;
      stats.drops.noScore++;
      continue;
    }
    stats.positionsAnalyzed++;

    if (samePv1(t.playedUci, pre[0].bestMove)) {
      stats.drops.samePv1++;
      continue;
    }
    if (Math.abs(wdlBefore) > options.skipDecidedWdl) {
      stats.drops.decided++;
      continue;
    }
    if (t.isGameOverAfter) {
      stats.drops.gameOver++;
      continue;
    }
    postCandidates.push({
      task: t,
      wdlBefore,
      wdlBeforeRaw: pre[0].wdl ?? null,
      pv1Before: pre[0].bestMove,
    });
  }

  if (postCandidates.length === 0) return;

  // ── Stage 3 (parallel): post-analyze fenAfter для кандидатов ────
  const fenAfterSet = Array.from(
    new Set(postCandidates.map((c) => c.task.fenAfter)),
  );
  const postMap = new Map<string, MultiPvLine[]>();
  await Promise.all(
    fenAfterSet.map(async (fen) => {
      try {
        const pvs = await engine.analyzePositionWdl(
          fen,
          options.engineLimit,
          2,
          `g=${row.id} phase=analyze stage=post`,
        );
        postMap.set(fen, pvs);
      } catch {
        postMap.set(fen, []);
      }
    }),
  );

  // ── Stage 4 (sync): blunderΔ + lowWdlAfterBlunder ────────────────
  interface SolvabilityCandidate {
    task: PlyTask;
    wdlBefore: number;
    wdlAfterForSolver: number;
    /** KS-2523: raw Wdl POV blunder (на fenBefore). */
    wdlBeforeRaw: Wdl | null;
    /** KS-2523: raw Wdl POV solver (на fenAfter). */
    wdlAfterRaw: Wdl | null;
    blunderDelta: number;
    firstMovePV1: string;
  }
  const solvabilityCandidates: SolvabilityCandidate[] = [];
  for (const c of postCandidates) {
    const post = postMap.get(c.task.fenAfter) ?? [];
    if (post.length === 0) {
      stats.drops.engineError++;
      continue;
    }
    const wdlAfterForSolver = wdlSignedFromInfo(post[0].wdl, post[0].score);
    if (wdlAfterForSolver == null) {
      stats.drops.noScore++;
      continue;
    }
    const blunderDelta = c.wdlBefore + wdlAfterForSolver;
    if (blunderDelta < options.blunderDelta) {
      stats.drops.notBlunder++;
      continue;
    }
    if (wdlAfterForSolver < options.minWdlAfterBlunder) {
      stats.drops.lowWdlAfterBlunder++;
      continue;
    }
    solvabilityCandidates.push({
      task: c.task,
      wdlBefore: c.wdlBefore,
      wdlAfterForSolver,
      wdlBeforeRaw: c.wdlBeforeRaw,
      wdlAfterRaw: post[0].wdl ?? null,
      blunderDelta,
      firstMovePV1: post[0].bestMove,
    });
  }

  if (solvabilityCandidates.length === 0) return;

  // ── Stage 5 (parallel between candidates, sequential within): ───
  // solvability check. Каждый кандидат — halfMovesN последовательных
  // SF-вызовов (Stockfish-vs-Stockfish), но между разными кандидатами
  // партии можно параллелить — пул сам сериализует.
  const solvableFlags = await Promise.all(
    solvabilityCandidates.map((sc) =>
      checkSolvability({
        engine,
        startFen: sc.task.fenAfter,
        solverSide: sc.task.solverSide,
        halfMovesN: options.halfMovesN,
        winThreshold: options.winThreshold,
        failThreshold: options.failThreshold,
        limit: options.engineLimit,
        gameId: row.id,
      }),
    ),
  );

  // ── Stage 6 (sequential): tagging + insert ──────────────────────
  // Insert последовательно — на стороне БД скорость не критична,
  // в анализе она не нужна.
  for (let i = 0; i < solvabilityCandidates.length; i++) {
    const sc = solvabilityCandidates[i];
    if (!solvableFlags[i]) {
      stats.drops.solvabilityFailed++;
      continue;
    }

    const tags = computeTags({
      startFen: sc.task.fenAfter,
      moves: [sc.firstMovePV1],
      finalCpForSolver: wdlToApproxCp(sc.wdlAfterForSolver),
      endsInMate: false,
    });
    tags.push('playVsEngine');

    const rating = computeStartingRating(row, sc.wdlAfterForSolver);
    // KS-2757. Зевнувший = side-to-move в позиции до зевка
    // (`fenBefore`). FEN-поле 2 ('w' | 'b'). Берём соответствующий
    // ELO из archive_games-row; null если у этой стороны рейтинга нет.
    const blundererSide = sc.task.fenBefore.split(/\s+/)[1] as 'w' | 'b';
    const blundererElo =
      blundererSide === 'w' ? row.white_elo : row.black_elo;
    const puzzle: PuzzleRecord = {
      id: randomUUID(),
      fen: sc.task.fenAfter,
      moves: '',
      rating,
      ratingDev: 350,
      themes: Array.from(new Set(tags)).sort().join(' '),
      source: 'generated',
      sourceType: 'archive_game',
      sourceId: row.id,
      sourceMoveNum: sc.task.ply,
      gap: Math.round(sc.wdlAfterForSolver * 100),
      depth: options.engineLimit.depth ?? 0,
      isPublic: true,
      acceptedMoves: null,
      solutionMode: options.solutionMode,
      blundererElo,
      sourceMetadata: JSON.stringify({
        blunderMove: sc.task.playedUci,
        // KS-2754. FEN позиции ДО зевка — нужен фронту чтобы собрать
        // SAN зевка (`apply(blunderMove, fenBeforeBlunder)` через
        // chess.js → SAN). На puzzle.fen (= fenAfter зевка) ход уже
        // применён, undo без истории невозможен.
        fenBeforeBlunder: sc.task.fenBefore,
        wdlBeforeBlunder: round3(sc.wdlBefore),
        wdlAfterBlunder: round3(sc.wdlAfterForSolver),
        blunderDelta: round3(sc.blunderDelta),
        firstMovePV1: sc.firstMovePV1,
        winThreshold: options.winThreshold,
        failThreshold: options.failThreshold,
        halfMovesN: options.halfMovesN,
        engine: 'stockfish',
        engineParams: options.engineLimit,
        generatedAt: new Date().toISOString(),
        // KS-2523: полные Wdl-объекты (per-mille от Stockfish). UI
        // (KS-2524) показывает три числа W/D/L отдельно. Старые
        // signed-поля `wdlBeforeBlunder`/`wdlAfterBlunder` сохранены
        // для backward-compat с legacy-пазлами.
        //
        // POV: Stockfish-native — `wdlBefore` от лица side-to-move в
        // позиции до зевка (= блундёр), `wdlAfter` от лица side-to-
        // move после хода (= решающая = солвер). Если у Stockfish не
        // было WDL (старые версии при mate) — поле не пишется,
        // фронт fallback'ом смотрит на signed.
        ...(sc.wdlBeforeRaw !== null ? { wdlBefore: sc.wdlBeforeRaw } : {}),
        ...(sc.wdlAfterRaw !== null ? { wdlAfter: sc.wdlAfterRaw } : {}),
        // KS-2489: PGN headers — для backend `resolveSourceGame`
        // (KS-2487) и frontend-блока «Из партии». Включаются только
        // если хоть один заголовок был. Резолвер на api игнорирует
        // отсутствие — sourceGame.archiveGameId всегда есть.
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
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

/**
 * KS-2489: ключи PGN-заголовков, которые мы сохраняем в `sourceMetadata.
 * headers` для дальнейшего показа на фронте (KS-2487/2488). Берём
 * стандартные Seven Tag Roster (`White/Black/Date/Event/Site/Round/
 * Result`) плюс ELO; остальные теги (`TimeControl`, `ECO`, `Variation`,
 * движковые теги Lichess `[Annotator]/[BlackTitle]` и т.д.) не нужны —
 * блок «Из партии» обходится этими.
 *
 * Возвращает только непустые значения. Пустой объект (нет ни одного
 * ключа) → `sourceMetadata.headers` не пишется (резолвер на api в
 * KS-2487 в любом случае проверяет наличие).
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
  /** Для phase-тегов в логе. */
  gameId?: string;
}

/**
 * Проверка решаемости: halfMovesN полуходов Stockfish-vs-Stockfish из
 * `startFen`. На каждом ply берём bestmove. После каждого
 * полухода-противника проверяем WDL для решающей; если < failThreshold —
 * drop. По окончании halfMovesN — если WDL ≥ winThreshold, проходит.
 *
 * Цикл по halfMovesN — последовательный по природе (надо знать ход
 * предыдущего ply, чтобы получить fen для следующего). Параллелизм —
 * между разными кандидатами (см. `Stage 5` в `processGame`).
 *
 * KS-2470 phase-теги для логов:
 *   - `phase=defend` — на ходу решающая (она «защищается» от того,
 *     чтобы упустить преимущество).
 *   - `phase=attack` — на ходу противник решающей.
 */
async function checkSolvability(args: SolvabilityArgs): Promise<boolean> {
  const { engine, startFen, solverSide, halfMovesN, winThreshold, failThreshold, limit, gameId } = args;
  const chess = new Chess(startFen);
  let lastWdlForSolver: number | null = null;
  const labelBase = gameId ? `g=${gameId} ` : '';

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
    const sideToMove = chess.turn() as 'w' | 'b';
    const phase = sideToMove === solverSide ? 'defend' : 'attack';
    let pvs: MultiPvLine[];
    try {
      pvs = await engine.analyzePositionWdl(
        chess.fen(),
        limit,
        1,
        `${labelBase}phase=${phase} solv-ply=${ply}`,
      );
    } catch {
      return false;
    }
    if (pvs.length === 0 || !pvs[0].bestMove) return false;
    const bm = pvs[0].bestMove;
    const wdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
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
    const sideToMove = chess.turn() as 'w' | 'b';
    const phase = sideToMove === solverSide ? 'defend' : 'attack';
    const finalPvs = await engine.analyzePositionWdl(
      chess.fen(),
      limit,
      1,
      `${labelBase}phase=${phase} solv-final`,
    );
    if (finalPvs.length > 0) {
      const w = wdlSignedFromInfo(finalPvs[0].wdl, finalPvs[0].score);
      if (w != null) {
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
