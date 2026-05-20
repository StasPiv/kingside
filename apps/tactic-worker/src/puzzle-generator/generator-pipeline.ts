/**
 * KS-2464 / ADR-044 §6, KS-3136 / ADR-068 §3.2 — Puzzle-generator
 * pipeline (play-vs-engine).
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
 *     5) KS-3136 / ADR-068: `evaluateBlunder` из shared — OR(deltaW≥X,
 *        deltaD≥X) + дифференцированный after-фильтр;
 *     6) solvability check — Promise.all между кандидатами,
 *        внутри одного кандидата последовательно по halfMovesN.
 *
 * Алгоритм фильтров:
 *   a. samePv1 — ход партии = PV1 движка → drop.
 *   b. (KS-3140) skipDecided снят — отсекал «реализуй перевес».
 *   c. gameOver — позиция терминальная после хода → drop.
 *   d. KS-3136 / ADR-068: `evaluateBlunder(...)` — единая (server+client)
 *      реализация триггера. Пороги hardcoded ниже как `HARD_*` константы,
 *      наружу не выставлены. Маппинг result.reason → drop-метрики:
 *      `notBlunder` / `lowWAfterForSolver` / `lowWplusDAfter`.
 *   e. Solvability: halfMovesN полуходов Stockfish-vs-Stockfish. WDL
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
import {
  determinePuzzleObjective,
  evaluateBlunder,
  holdsSolvabilityIntermediate,
  meetsSolvabilityFinal,
  wdlOrMateFallback,
  type BlunderEvalSettings,
  type PuzzleObjective,
} from '@kingside/shared';
import type { MultiPvLine } from './types';
import { computeTags } from './tagging';

/**
 * KS-3136 / ADR-068 §1.2 + KS-3140: пороги генератора в серверной
 * обёртке — hardcoded в модуле, не из ENV/CLI/options. Клиентский
 * генератор (`apps/web/src/utils/puzzleGenerator.ts`) использует те же
 * дефолты через `PUZZLE_GEN_DEFAULTS`, но допускает их перекрытие в UI.
 *
 * KS-3140: убрано раздельное `HARD_MIN_W_AFTER` — теперь единый
 * after-фильтр `HARD_MIN_WD_AFTER` (W+D solver ≥ X), пропускающий и
 * «реализуй перевес», и «спасение в ничью».
 */
const HARD_DELTA_W = 0.6;
const HARD_DELTA_D = 0.6;
const HARD_MIN_WD_AFTER = 0.5;

const BLUNDER_EVAL_SETTINGS: BlunderEvalSettings = {
  deltaWThreshold: HARD_DELTA_W,
  deltaDThreshold: HARD_DELTA_D,
  minWPlusDAfterForSolver: HARD_MIN_WD_AFTER,
};

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

  // KS-2776. Динамическая сборка WHERE: cursor, import_id, exclude-list.
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
     * KS-2523 / KS-3136: полный Wdl-объект POV блундёра на fenBefore
     * с mate-фолбэком (см. `wdlOrMateFallback`). Гарантированно
     * не-null на этой стадии — иначе кандидат drop'нулся как noScore.
     */
    wdlBeforeRaw: Wdl;
    pv1Before: string;
  }
  const postCandidates: PostCandidate[] = [];
  for (const t of tasks) {
    const pre = preMap.get(t.fenBefore) ?? [];
    if (pre.length === 0) {
      // pre упал — не считаем positionsAnalyzed (как в старой логике).
      continue;
    }
    // KS-3136: полный Wdl с mate-фолбэком — нужен в Stage 4 для
    // evaluateBlunder. signed-проекция нужна для метаданных/телеметрии.
    const wdlBeforeRaw = wdlOrMateFallback(pre[0].wdl, pre[0].score);
    if (wdlBeforeRaw == null) {
      stats.positionsAnalyzed++;
      stats.drops.noScore++;
      continue;
    }
    const wdlBefore = wdlSignedFromInfo(pre[0].wdl, pre[0].score);
    if (wdlBefore == null) {
      // Не должно случиться (если wdlOrMateFallback вернул не-null,
      // wdlSignedFromInfo тоже даст значение), но защита.
      stats.positionsAnalyzed++;
      stats.drops.noScore++;
      continue;
    }
    stats.positionsAnalyzed++;

    if (samePv1(t.playedUci, pre[0].bestMove)) {
      stats.drops.samePv1++;
      continue;
    }
    // KS-3140: skipDecided (|wdlBefore| > 0.95) убран. Он отсекал
    // классические пазлы «реализуй перевес» (форсированный выигрыш до
    // зевка). Терминальные позиции (мат/пат) и так покрываются
    // gameOver-проверкой ниже через chess.js.
    if (t.isGameOverAfter) {
      stats.drops.gameOver++;
      continue;
    }
    postCandidates.push({
      task: t,
      wdlBefore,
      wdlBeforeRaw,
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

  // ── Stage 4 (sync): KS-3136 / ADR-068 — evaluateBlunder ──────────
  // Единая реализация триггера для сервера и клиента (`@kingside/shared`).
  // Пороги hardcoded (HARD_DELTA_W/D, HARD_MIN_W_AFTER, HARD_MIN_WD_AFTER).
  interface SolvabilityCandidate {
    task: PlyTask;
    wdlBefore: number;
    wdlAfterForSolver: number;
    /** Raw Wdl POV blunder (на fenBefore), с mate-фолбэком. */
    wdlBeforeRaw: Wdl;
    /** Raw Wdl POV solver (на fenAfter), с mate-фолбэком. */
    wdlAfterRaw: Wdl;
    /** KS-3136 / ADR-068. Дельты от лица блaндера. */
    deltaW: number;
    deltaD: number;
    firstMovePV1: string;
  }
  const solvabilityCandidates: SolvabilityCandidate[] = [];
  for (const c of postCandidates) {
    const post = postMap.get(c.task.fenAfter) ?? [];
    if (post.length === 0) {
      stats.drops.engineError++;
      continue;
    }
    const wdlAfterRaw = wdlOrMateFallback(post[0].wdl, post[0].score);
    if (wdlAfterRaw == null) {
      stats.drops.noScore++;
      continue;
    }
    const wdlAfterForSolver = wdlSignedFromInfo(post[0].wdl, post[0].score);
    if (wdlAfterForSolver == null) {
      stats.drops.noScore++;
      continue;
    }

    const result = evaluateBlunder(
      { wdlBeforeRaw: c.wdlBeforeRaw, wdlAfterRaw },
      BLUNDER_EVAL_SETTINGS,
    );
    if (result.kind === 'rejected') {
      switch (result.reason) {
        case 'notBlunder':
          stats.drops.notBlunder++;
          break;
        case 'lowWplusDAfter':
          stats.drops.lowWplusDAfter++;
          break;
      }
      continue;
    }
    solvabilityCandidates.push({
      task: c.task,
      wdlBefore: c.wdlBefore,
      wdlAfterForSolver,
      wdlBeforeRaw: c.wdlBeforeRaw,
      wdlAfterRaw,
      deltaW: result.deltaW,
      deltaD: result.deltaD,
      firstMovePV1: post[0].bestMove,
    });
  }

  if (solvabilityCandidates.length === 0) return;

  // KS-3157: Stage 5 (solvability-check) отключён по решению пользователя.
  //
  // Раньше каждый кандидат, прошедший evaluateBlunder, прогонялся через
  // halfMovesN полуходов Stockfish-vs-Stockfish и принимался только если
  // итоговое значение оценки соответствовало критерию (signed для
  // convertAdvantage, W+D для saveEquality после KS-3156).
  //
  // Аргументы за отключение:
  //  - Клиентский генератор пазлов (apps/web) работает без solvability-
  //    проверки по умолчанию (флажок выключен в UI), и продуцирует
  //    рабочие пазлы — пользователи не жалуются.
  //  - evaluateBlunder уже жёстко фильтрует: deltaW≥0.6 или deltaD≥0.6,
  //    плюс after-фильтр W+D solver ≥ 0.5.
  //  - Проверка занимает ~halfMovesN × time-ms на каждого кандидата —
  //    основная доля времени генерации.
  //
  // Цена: ~5-15 % сохранённых пазлов потенциально низкого качества
  // (формально проходят фильтр, но в практической игре solver
  // не реализует/не удерживает оценку).
  //
  // Функция `checkSolvability` оставлена в файле без вызова — на случай
  // если решение откатится.
  const objectivesPerCandidate: PuzzleObjective[] = solvabilityCandidates.map(
    (sc) => determinePuzzleObjective(sc.wdlAfterRaw),
  );

  // ── Stage 5 (отключено): solvability-check пропущен ─────────────
  // Все solvabilityCandidates считаются прошедшими (solvableFlags=[true,...]).

  // ── Stage 6 (sequential): tagging + insert ──────────────────────
  // Insert последовательно — на стороне БД скорость не критична,
  // в анализе она не нужна.
  for (let i = 0; i < solvabilityCandidates.length; i++) {
    const sc = solvabilityCandidates[i];

    const tags = computeTags({
      startFen: sc.task.fenAfter,
      moves: [sc.firstMovePV1],
      finalCpForSolver: wdlToApproxCp(sc.wdlAfterForSolver),
      endsInMate: false,
    });
    tags.push('playVsEngine');
    // KS-3145 / ADR-069: жанр пазла — `convertAdvantage` (solver
    // в выигранной позиции) или `saveEquality` (solver не в выигрыше,
    // но держит ничью). Дублируется тегом для фильтра на
    // /puzzles/browse и в /precision.
    const objective = objectivesPerCandidate[i];
    tags.push(objective);

    const rating = computeStartingRating(row, sc.wdlAfterForSolver);
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
      // KS-2762. Денормализованные ELO для фильтра на /precision —
      // чтобы /puzzles/browse не делал FDW JOIN на archive_games.
      sourceWhiteElo: row.white_elo,
      sourceBlackElo: row.black_elo,
      sourceMetadata: JSON.stringify({
        blunderMove: sc.task.playedUci,
        // KS-2754. FEN позиции ДО зевка — нужен фронту чтобы собрать
        // SAN зевка (`apply(blunderMove, fenBeforeBlunder)` через
        // chess.js → SAN). На puzzle.fen (= fenAfter зевка) ход уже
        // применён, undo без истории невозможен.
        fenBeforeBlunder: sc.task.fenBefore,
        wdlBeforeBlunder: round3(sc.wdlBefore),
        wdlAfterBlunder: round3(sc.wdlAfterForSolver),
        // KS-3136 / ADR-068: новые независимые метрики «зевок».
        // Поле `blunderDelta` (legacy свёртка W−L) больше не пишем —
        // resolveSolutionMode на api использует `deltaW`/`deltaD` для
        // новых пазлов, fallback на `wdlAfterBlunder` для legacy.
        deltaW: round3(sc.deltaW),
        deltaD: round3(sc.deltaD),
        // KS-3145 / ADR-069: жанр пазла. API возвращает в DTO для UI;
        // legacy-пазлы без поля резолверятся через fallback на
        // `wdlAfter.w` или `wdlAfterBlunder`.
        objective,
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
        // move после хода (= решающая = солвер). KS-3136: после
        // mate-фолбэка `wdlBeforeRaw`/`wdlAfterRaw` всегда не-null
        // на этой стадии — пишем безусловно.
        wdlBefore: sc.wdlBeforeRaw,
        wdlAfter: sc.wdlAfterRaw,
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
  /**
   * KS-3156: цель пазла. Определяет интерпретацию порогов:
   *   - `convertAdvantage` — signed WDL (W − L) ≥ winThreshold/failThreshold.
   *   - `saveEquality` — (W + D) ≥ winThreshold/failThreshold.
   * До KS-3156 был только первый вариант, что не давало saveEquality
   * пройти solvability ни при каких реальных позициях.
   */
  objective: PuzzleObjective;
  limit: import('./types').AnalysisLimit;
  /** Для phase-тегов в логе. */
  gameId?: string;
}

/** POV solver — Wdl на текущем ply, side-to-move = solver или его противник. */
function wdlPovSolver(
  wdl: { w: number; d: number; l: number } | null | undefined,
  sideToMove: 'w' | 'b',
  solverSide: 'w' | 'b',
): import('@kingside/shared').Wdl | null {
  if (!wdl) return null;
  // Stockfish отдаёт POV side-to-move. Если sideToMove == solverSide —
  // wdl уже от лица solver. Иначе W↔L меняются местами (D сохраняется).
  if (sideToMove === solverSide) return { w: wdl.w, d: wdl.d, l: wdl.l };
  return { w: wdl.l, d: wdl.d, l: wdl.w };
}

/**
 * Проверка решаемости: halfMovesN полуходов Stockfish-vs-Stockfish из
 * `startFen`. На каждом ply берём bestmove. После каждого
 * полухода-противника проверяем WDL для решающей; если не выполняется
 * holdsSolvabilityIntermediate — drop. По окончании halfMovesN — если
 * meetsSolvabilityFinal вернул true, проходит.
 *
 * KS-3156: критерий ветвится по `objective`:
 *   - convertAdvantage → signed WDL (старое поведение).
 *   - saveEquality → (W + D) ≥ threshold — solver должен удерживать
 *     не-проигрышную сумму выше порога. Без этой ветки signed≈0 у
 *     ничейных позиций структурно валил финальный чек.
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
  const {
    engine,
    startFen,
    solverSide,
    halfMovesN,
    winThreshold,
    failThreshold,
    objective,
    limit,
    gameId,
  } = args;
  const chess = new Chess(startFen);
  let lastWdlForSolver: import('@kingside/shared').Wdl | null = null;
  const labelBase = gameId ? `g=${gameId} ` : '';

  for (let ply = 0; ply < halfMovesN; ply++) {
    if (chess.isGameOver()) {
      if (chess.isCheckmate()) {
        // Сторона на ходу = проигравшая (получила мат). Если это
        // противник solver — solver выиграл, что для convertAdvantage
        // успех; для saveEquality solver неожиданно выиграл, тоже не
        // фейл (W+D = 1.0 → проходит финальный чек).
        const losingSide = chess.turn() as 'w' | 'b';
        return losingSide !== solverSide;
      }
      // Стейлмейт/3-fold/50-move — позиция ничейная. Для saveEquality
      // это **успех** (solver удержал ничью), для convertAdvantage —
      // фейл (solver не реализовал перевес).
      return objective === 'saveEquality';
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
    const wdlRaw = wdlOrMateFallback(pvs[0].wdl, pvs[0].score);
    const wdlSolver = wdlPovSolver(wdlRaw, sideToMove, solverSide);
    if (wdlSolver != null) {
      lastWdlForSolver = wdlSolver;
      if (!holdsSolvabilityIntermediate(wdlSolver, objective, failThreshold)) {
        return false;
      }
    }
    if (!applyUci(chess, bm)) return false;
  }

  // Финальная позиция — анализируем ещё раз для итогового WDL solver.
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
      const wdlRaw = wdlOrMateFallback(finalPvs[0].wdl, finalPvs[0].score);
      const wdlSolver = wdlPovSolver(wdlRaw, sideToMove, solverSide);
      if (wdlSolver != null) lastWdlForSolver = wdlSolver;
    }
  } catch {
    // Используем последний известный
  }

  if (lastWdlForSolver == null) return false;
  return meetsSolvabilityFinal(lastWdlForSolver, objective, winThreshold);
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
    `gameOver=${stats.drops.gameOver} ` +
    `lowWplusDAfter=${stats.drops.lowWplusDAfter} ` +
    // KS-3156: solvability-провалы — отдельно по convertAdvantage и
    // saveEquality. Раньше показывали агрегат; он маскировал
    // структурный 100 %-провал saveEquality.
    `solvabilityFailedConvert=${stats.drops.solvabilityFailedConvertAdvantage} ` +
    `solvabilityFailedSave=${stats.drops.solvabilityFailedSaveEquality} ` +
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
