/**
 * Аналитический CLI subcommand `analyze-pgn`.
 *
 * Назначение: прогнать ОДНУ партию через тот же пайплайн, что и
 * `generate-puzzles`, но без insert'а в БД и с подробным выводом
 * per-ply таблицы. Используется для отладки/калибровки порогов
 * blunderDelta (X) и spreadDelta (Y) на конкретных PGN.
 *
 * Алгоритм:
 *   На каждом ply ≥ startPly:
 *     1. analyzePositionWdl(FEN_before, limit, multiPV=2) → preBefore.
 *        - wdl_before = WDL первой линии движка ДО хода (от лица того,
 *          кто делает ход).
 *     2. Применяем ход партии.
 *     3. analyzePositionWdl(FEN_after, limit, multiPV=2) → postAfter.
 *        - wdl_after_played = -postAfter[0].wdl (от лица сделавшего ход).
 *        - spread_after = postAfter[0].wdl - postAfter[1].wdl (Y-метрика).
 *     4. blunderΔ = wdl_before − wdl_after_played (X-метрика).
 *     5. Вердикт: candidate | notBlunder | notUnique.
 *
 * Вывод: CSV-файл + краткая сводка в stdout.
 *
 * Контракт CLI:
 *   node dist/main.js analyze-pgn \
 *     --pgn-file=/tmp/game.pgn \
 *     [--out=/tmp/game-analysis.csv]   default /tmp/analyze-pgn.csv
 *     [--blunder-delta=X]              default 0.5
 *     [--spread-delta=Y]               default 0.3
 *     [--start-ply=N]                  default 20
 *     [--depth=N]                      default 20
 *     [--time-ms=N]                    default 5000
 *     [--nodes=N]                      default 2000000
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Chess } from 'chess.js';
import { readFile, writeFile } from 'node:fs/promises';
import { StockfishService } from '../stockfish/stockfish.service';
import type { AnalysisLimit, MultiPvLine } from '../stockfish/stockfish.service';
import { wdlSignedFromInfo } from '../puzzle-generator/score';
// findHangingPiece не используется: предикат «взять незащищённую» здесь
// упрощённый — взятие фигуры, у которой 0 защитников в позиции до хода.
import { buildForcedLine } from '../puzzle-generator/line-builder';

interface CliFlags {
  pgnFile: string;
  outFile: string;
  blunderDelta: number;
  spreadDelta: number;
  startPly: number;
  engineLimit: AnalysisLimit;
  maxGames: number;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    pgnFile: '',
    outFile: '/tmp/analyze-pgn.csv',
    blunderDelta: 0.5,
    spreadDelta: 0.3,
    startPly: 20,
    engineLimit: { depth: 20 },
    maxGames: 0,
  };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'pgn-file':
        flags.pgnFile = v;
        break;
      case 'out':
        flags.outFile = v;
        break;
      case 'blunder-delta':
        flags.blunderDelta = parseFloat(v);
        break;
      case 'spread-delta':
        flags.spreadDelta = parseFloat(v);
        break;
      case 'start-ply':
        flags.startPly = parseInt(v, 10);
        break;
      case 'depth':
        flags.engineLimit = { depth: parseInt(v, 10) };
        break;
      case 'time-ms':
        flags.engineLimit = { timeMs: parseInt(v, 10) };
        break;
      case 'nodes':
        flags.engineLimit = { nodes: parseInt(v, 10) };
        break;
      case 'max-games':
        flags.maxGames = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  if (!flags.pgnFile) {
    throw new Error('--pgn-file is required');
  }
  return flags;
}

/**
 * Разбивает многоигровый PGN на отдельные партии. PGN-партии разделены
 * tag-блоками: каждая начинается с `[Event ...]` тега в начале строки.
 */
function splitPgnGames(pgn: string): string[] {
  const games = pgn.split(/(?=^\[Event )/m);
  return games.map((g) => g.trim()).filter((g) => g.length > 0);
}

interface PuzzleOut {
  gameIndex: number;
  ply: number;
  blunderer: 'W' | 'B';
  blunderSan: string;
  fenAfter: string;
  solutionSan: string[];
}

function stripPgnAnnotations(pgn: string): string {
  let out = pgn;
  out = out.replace(/\{[^}]*\}/g, '');
  for (let i = 0; i < 20; i++) {
    const next = out.replace(/\([^()]*\)/g, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\$\d+/g, '');
  out = out.replace(/\s+/g, ' ');
  return out;
}

interface PlyRow {
  gameIndex: number;
  ply: number;
  side: 'W' | 'B';
  moveSan: string;
  moveUci: string;
  wdlBefore: number | null;
  wdlAfterPlayed: number | null;
  spreadAfter: number | null;
  blunderDelta: number | null;
  capture: boolean;
  hangingCapture: boolean;
  givesCheck: boolean;
  captureLowerValue: boolean;
  captureHigherValue: boolean;
  destUndefended: boolean;
  pv1Capture: boolean;
  pv1HangingCapture: boolean;
  pv1GivesCheck: boolean;
  pv1CaptureLowerValue: boolean;
  pv1CaptureHigherValue: boolean;
  pv1DestUndefended: boolean;
  pv1BeforeSan: string;
  fenAfter: string;
  pv1AfterSan: string;
  pv1AfterUci: string;
  piecesCount: number;
  verdict: string;
}

function parseUci(uci: string): {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
} {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion:
      uci.length > 4 ? (uci.slice(4) as 'q' | 'r' | 'b' | 'n') : undefined,
  };
}

/**
 * Проверка: ход — взятие фигуры, у которой нет защитников
 * в позиции ДО хода (включая en passant — pawn-target учитывается через
 * chess.move/captured).
 */
function isCaptureOfUndefended(fenBefore: string, uci: string): boolean {
  const ref = new Chess(fenBefore);
  const probe = new Chess(fenBefore);
  const bm = parseUci(uci);
  let made;
  try {
    made = probe.move({
      from: bm.from,
      to: bm.to,
      ...(bm.promotion ? { promotion: bm.promotion } : {}),
    });
  } catch {
    return false;
  }
  if (!made || !made.captured) return false;
  const enemy = ref.turn() === 'w' ? 'b' : 'w';
  const defenders = ref.attackers(bm.to as never, enemy);
  return defenders.length === 0;
}

/**
 * Проверка: после хода поле назначения не защищено нашими собственными
 * фигурами. То есть наша фигура, стоящая на цели после хода, висит без
 * поддержки своих.
 */
function isDestinationUndefended(fenBefore: string, uci: string): boolean {
  const probe = new Chess(fenBefore);
  const our = probe.turn() as 'w' | 'b';
  const bm = parseUci(uci);
  let made;
  try {
    made = probe.move({
      from: bm.from,
      to: bm.to,
      ...(bm.promotion ? { promotion: bm.promotion } : {}),
    });
  } catch {
    return false;
  }
  if (!made) return false;
  const defenders = probe.attackers(bm.to as never, our);
  return defenders.length === 0;
}

const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

function uciOf(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function fmt(n: number | null, digits = 3): string {
  if (n == null) return '';
  if (!isFinite(n)) return n > 0 ? '+inf' : '-inf';
  return n.toFixed(digits);
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function runAnalyzePgn(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:analyze-pgn');
  const flags = parseArgs(argv);

  const engine = app.get(StockfishService);

  const raw = await readFile(flags.pgnFile, 'utf8');
  const games = splitPgnGames(raw);
  const gameLimit =
    flags.maxGames > 0 ? Math.min(flags.maxGames, games.length) : games.length;

  process.stdout.write(
    `[analyze-pgn] file=${flags.pgnFile} games_in_file=${games.length} ` +
      `processing=${gameLimit} startPly=${flags.startPly} ` +
      `X=${flags.blunderDelta} Y=${flags.spreadDelta} ` +
      `limit={depth=${flags.engineLimit.depth},time=${flags.engineLimit.timeMs}ms,nodes=${flags.engineLimit.nodes}}\n`,
  );

  const allRows: PlyRow[] = [];
  const allPuzzles: PuzzleOut[] = [];

  const processGame = async (gameIndex: number): Promise<void> => {
    const gameRaw = games[gameIndex];
    const pgn = stripPgnAnnotations(gameRaw);

    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch (e) {
      process.stderr.write(
        `[analyze-pgn] game ${gameIndex} parse failed: ${(e as Error).message}\n`,
      );
      return;
    }
    const history = chess.history({ verbose: true });
    if (history.length < flags.startPly) return;

    process.stdout.write(
      `[analyze-pgn] game ${gameIndex + 1}/${gameLimit}: plies=${history.length}\n`,
    );

    const replay = new Chess();
    const rowsByPly = new Map<number, PlyRow>();

  // ── Pass 1: replay + геометрический pre-filter, собираем задачи ─
  interface AnalyzeTask {
    ply: number;
    side: 'W' | 'B';
    moveSan: string;
    moveUciStr: string;
    fenBefore: string;
    fenAfter: string;
    capture: boolean;
    hangingCapture: boolean;
    givesCheck: boolean;
    captureLowerValue: boolean;
    captureHigherValue: boolean;
    destUndefended: boolean;
    piecesCount: number;
    isGameOverAfter: boolean;
  }
  const tasks: AnalyzeTask[] = [];

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    const side: 'W' | 'B' = replay.turn() === 'w' ? 'W' : 'B';

    if (ply < flags.startPly || replay.isGameOver()) {
      replay.move({
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
      });
      continue;
    }

    const fenBefore = replay.fen();

    // ── геометрический pre-compute через probe (без движка) ─
    const probeBefore = new Chess(fenBefore);
    let probeMadeMove;
    try {
      probeMadeMove = probeBefore.move({
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
      });
    } catch {
      break;
    }
    if (!probeMadeMove) break;

    const givesCheck = probeBefore.inCheck();
    const capture = !!probeMadeMove.captured;
    let captureLowerValue = false;
    let captureHigherValue = false;
    if (probeMadeMove.captured) {
      const attackerVal = PIECE_VALUE[probeMadeMove.piece] ?? 0;
      const capturedVal = PIECE_VALUE[probeMadeMove.captured] ?? 0;
      captureLowerValue = capturedVal < attackerVal;
      captureHigherValue = capturedVal > attackerVal;
    }
    const hangingCapture = isCaptureOfUndefended(fenBefore, uciOf(m));
    const destUndefended = isDestinationUndefended(fenBefore, uciOf(m));
    const piecesCount = (fenBefore.split(' ')[0].match(/[rnbqkpRNBQKP]/g) ?? [])
      .length;

    // Применяем ход на главной доске и собираем задачу для движка.
    let madeMove;
    try {
      madeMove = replay.move({
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
      });
    } catch {
      break;
    }
    if (!madeMove) break;

    tasks.push({
      ply,
      side,
      moveSan: m.san,
      moveUciStr: uciOf(m),
      fenBefore,
      fenAfter: replay.fen(),
      capture,
      hangingCapture,
      givesCheck,
      captureLowerValue,
      captureHigherValue,
      destUndefended,
      piecesCount,
      isGameOverAfter: replay.isGameOver(),
    });
  }

  // ── Stage 1: parallel pre-analyses ─────────────────────────────
  // Параллельно анализируем все fenBefore. Pool из STOCKFISH_POOL_SIZE
  // воркеров автоматически распределит вызовы по ядрам.
  const stage1Fens = Array.from(new Set(tasks.map((t) => t.fenBefore)));
  process.stdout.write(
    `[analyze-pgn] stage1: ${stage1Fens.length} pre-analyses dispatched (parallel within game)\n`,
  );
  const analysisMap = new Map<string, MultiPvLine[]>();
  const earlyStopByFen = new Map<string, 'X' | 'Y'>();
  // Параллельно внутри партии — пул раздаёт по 16 воркерам.
  await Promise.all(
    stage1Fens.map(async (fen) => {
      try {
        const pvs = await engine.analyzePositionWdl(
          fen,
          flags.engineLimit,
          2,
          `g=${gameIndex} stage=1`,
        );
        analysisMap.set(fen, pvs);
      } catch {
        analysisMap.set(fen, []);
      }
    }),
  );

  // ── Stage 2: skipDecided + parallel post-analyses (с adaptive) ─
  // Для каждой задачи смотрим wdl_before. Если |wdl_before| > 0.95,
  // партия решена — post не нужен. Иначе fenAfter в очередь stage2.
  // Adaptive early-stop: на 3 подряд глубинах X<0.6 ИЛИ Y<0.6 → stop.
  const decidedPlies = new Set<number>();
  const stage2Tasks: Array<{ fen: string; preWdl: number | null }> = [];
  const seenFenAfter = new Set<string>();
  for (const t of tasks) {
    const pre = analysisMap.get(t.fenBefore) ?? [];
    let preWdl: number | null = null;
    if (pre.length > 0) {
      preWdl = wdlSignedFromInfo(pre[0].wdl, pre[0].score);
      if (preWdl != null && Math.abs(preWdl) > 0.95) {
        decidedPlies.add(t.ply);
        continue;
      }
    }
    if (
      !t.isGameOverAfter &&
      !analysisMap.has(t.fenAfter) &&
      !seenFenAfter.has(t.fenAfter)
    ) {
      seenFenAfter.add(t.fenAfter);
      stage2Tasks.push({ fen: t.fenAfter, preWdl });
    }
  }
  process.stdout.write(
    `[analyze-pgn] stage2: ${stage2Tasks.length} post-analyses dispatched ` +
      `(${decidedPlies.size} ply пропущены как decided)\n`,
  );
  // Stage 2 параллельно внутри партии.
  await Promise.all(
    stage2Tasks.map(async ({ fen }) => {
      try {
        const pvs = await engine.analyzePositionWdl(
          fen,
          flags.engineLimit,
          2,
          `g=${gameIndex} stage=2`,
        );
        analysisMap.set(fen, pvs);
      } catch {
        analysisMap.set(fen, []);
      }
    }),
  );

  // ── Pass 2: build full rows ───────────────────────────────────
  for (const t of tasks) {
    const preBefore = analysisMap.get(t.fenBefore) ?? [];
    const postAfter = decidedPlies.has(t.ply)
      ? []
      : analysisMap.get(t.fenAfter) ?? [];

    let pv1Capture = false;
    let pv1HangingCapture = false;
    let pv1GivesCheck = false;
    let pv1CaptureLowerValue = false;
    let pv1CaptureHigherValue = false;
    let pv1DestUndefended = false;
    const bestUci = preBefore.length > 0 ? preBefore[0].bestMove : null;
    if (bestUci) {
      const probe = new Chess(t.fenBefore);
      const bm = parseUci(bestUci);
      try {
        const made = probe.move({
          from: bm.from,
          to: bm.to,
          ...(bm.promotion ? { promotion: bm.promotion } : {}),
        });
        if (made) {
          pv1GivesCheck = probe.inCheck();
          pv1Capture = !!made.captured;
          if (made.captured) {
            const aV = PIECE_VALUE[made.piece] ?? 0;
            const cV = PIECE_VALUE[made.captured] ?? 0;
            pv1CaptureLowerValue = cV < aV;
            pv1CaptureHigherValue = cV > aV;
          }
          pv1HangingCapture = isCaptureOfUndefended(t.fenBefore, bestUci);
          pv1DestUndefended = isDestinationUndefended(t.fenBefore, bestUci);
        }
      } catch {
        /* invalid PV — flags остаются false */
      }
    }

    const wdlBefore =
      preBefore.length > 0
        ? wdlSignedFromInfo(preBefore[0].wdl, preBefore[0].score)
        : null;
    const wdlAfterPv1Solver =
      postAfter.length > 0
        ? wdlSignedFromInfo(postAfter[0].wdl, postAfter[0].score)
        : null;
    const wdlAfterPv2Solver =
      postAfter.length > 1
        ? wdlSignedFromInfo(postAfter[1].wdl, postAfter[1].score)
        : null;
    const spreadAfter =
      wdlAfterPv1Solver != null && wdlAfterPv2Solver != null
        ? wdlAfterPv1Solver - wdlAfterPv2Solver
        : null;
    const wdlAfterPlayed =
      wdlAfterPv1Solver != null ? -wdlAfterPv1Solver : null;
    const blunderDelta =
      wdlBefore != null && wdlAfterPlayed != null
        ? wdlBefore - wdlAfterPlayed
        : null;

    const xPass = blunderDelta != null && blunderDelta >= flags.blunderDelta;
    const yPass = spreadAfter != null && spreadAfter >= flags.spreadDelta;

    let pv1BeforeSan = '';
    if (preBefore.length > 0) {
      const probe = new Chess(t.fenBefore);
      const bm = parseUci(preBefore[0].bestMove);
      try {
        const made = probe.move({
          from: bm.from,
          to: bm.to,
          ...(bm.promotion ? { promotion: bm.promotion } : {}),
        });
        if (made) pv1BeforeSan = made.san;
      } catch {
        /* invalid PV */
      }
    }

    // Алгоритм после рефакторинга — только поиск зевков. Линий решения
    // не строим, Y-фильтр (uniqueness) не применяем; интерактивная игра
    // решателя против движка делается на клиенте.
    const earlyReason = earlyStopByFen.get(t.fenAfter);

    let verdict: string;
    if (t.isGameOverAfter) {
      verdict = 'gameOver';
    } else if (decidedPlies.has(t.ply)) {
      verdict = 'decided';
    } else if (earlyReason === 'X') {
      verdict = 'notBlunder';
    } else if (!xPass) {
      verdict = 'notBlunder';
    } else if (pv1BeforeSan && pv1BeforeSan === t.moveSan) {
      verdict = 'samePv1';
    } else {
      verdict = 'blunder';
    }
    void yPass;

    let pv1AfterSan = '';
    const pv1AfterUci = postAfter.length > 0 ? postAfter[0].bestMove : '';
    if (postAfter.length > 0 && !t.isGameOverAfter) {
      const probe = new Chess(t.fenAfter);
      const bm = parseUci(postAfter[0].bestMove);
      try {
        const made = probe.move({
          from: bm.from,
          to: bm.to,
          ...(bm.promotion ? { promotion: bm.promotion } : {}),
        });
        if (made) pv1AfterSan = made.san;
      } catch {
        /* invalid PV */
      }
    }

    rowsByPly.set(t.ply, {
      gameIndex,
      ply: t.ply,
      side: t.side,
      moveSan: t.moveSan,
      moveUci: t.moveUciStr,
      wdlBefore,
      wdlAfterPlayed,
      spreadAfter,
      blunderDelta,
      capture: t.capture,
      hangingCapture: t.hangingCapture,
      givesCheck: t.givesCheck,
      captureLowerValue: t.captureLowerValue,
      captureHigherValue: t.captureHigherValue,
      destUndefended: t.destUndefended,
      pv1Capture,
      pv1HangingCapture,
      pv1GivesCheck,
      pv1CaptureLowerValue,
      pv1CaptureHigherValue,
      pv1DestUndefended,
      pv1BeforeSan,
      fenAfter: t.fenAfter,
      pv1AfterSan,
      pv1AfterUci,
      piecesCount: t.piecesCount,
      verdict,
    });
  }

    // Собираем gameRows[] в порядке ply (одной партии).
    const gameRows: PlyRow[] = Array.from(rowsByPly.keys())
      .sort((a, b) => a - b)
      .map((ply) => rowsByPly.get(ply) as PlyRow);

    const gamePuzzles: PuzzleOut[] = [];

    // Линии решения больше не строим (рефакторинг: только поиск
    // зевков). Решение играется на клиенте против движка до достижения
    // порога WDL. В выходной список пишем только саму позицию-зевок.
    for (const r of gameRows) {
      if (r.verdict !== 'blunder') continue;
      gamePuzzles.push({
        gameIndex,
        ply: r.ply,
        blunderer: r.side,
        blunderSan: r.moveSan,
        fenAfter: r.fenAfter,
        solutionSan: [],
      });
    }

    allRows.push(...gameRows);
    allPuzzles.push(...gamePuzzles);
  };

  // Concurrency-limit: одновременно не более N партий, чтобы не залить
  // Stockfish-pool тысячами параллельных запросов (он встаёт колом).
  const concurrency = Math.max(
    1,
    Number(process.env.GAME_CONCURRENCY ?? 16) || 16,
  );
  let nextGame = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, gameLimit) }, async () => {
      while (true) {
        const idx = nextGame++;
        if (idx >= gameLimit) return;
        await processGame(idx);
      }
    }),
  );
  // === конец цикла по партиям ===

  const rows = allRows;
  const puzzles = allPuzzles;

  const header = [
    'game_index',
    'ply',
    'side',
    'move_san',
    'pv1_before_san',
    'wdl_before',
    'wdl_after_played',
    'spread_after',
    'blunder_delta',
    'capture',
    'hanging_capture',
    'gives_check',
    'capture_lower_value',
    'capture_higher_value',
    'dest_undefended',
    'pv1_capture',
    'pv1_hanging_capture',
    'pv1_gives_check',
    'pv1_capture_lower_value',
    'pv1_capture_higher_value',
    'pv1_dest_undefended',
    'pieces_count',
    'fen_after',
    'pv1_after_san',
    'verdict',
  ].join(',');
  const body = rows
    .map((r) =>
      [
        r.gameIndex,
        r.ply,
        r.side,
        csvEscape(r.moveSan),
        csvEscape(r.pv1BeforeSan),
        fmt(r.wdlBefore),
        fmt(r.wdlAfterPlayed),
        fmt(r.spreadAfter),
        fmt(r.blunderDelta),
        r.capture ? '1' : '0',
        r.hangingCapture ? '1' : '0',
        r.givesCheck ? '1' : '0',
        r.captureLowerValue ? '1' : '0',
        r.captureHigherValue ? '1' : '0',
        r.destUndefended ? '1' : '0',
        r.pv1Capture ? '1' : '0',
        r.pv1HangingCapture ? '1' : '0',
        r.pv1GivesCheck ? '1' : '0',
        r.pv1CaptureLowerValue ? '1' : '0',
        r.pv1CaptureHigherValue ? '1' : '0',
        r.pv1DestUndefended ? '1' : '0',
        r.piecesCount,
        csvEscape(r.fenAfter),
        csvEscape(r.pv1AfterSan),
        r.verdict,
      ].join(','),
    )
    .join('\n');
  await writeFile(flags.outFile, header + '\n' + body + '\n');

  const verdicts: Record<string, number> = {};
  for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  const verdictsStr = Object.entries(verdicts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  process.stdout.write(
    `[analyze-pgn] done. rows=${rows.length} verdicts:{${verdictsStr}} out=${flags.outFile}\n`,
  );

  process.stdout.write(`[analyze-pgn] blunders=${puzzles.length}\n`);
  for (const p of puzzles) {
    process.stdout.write(
      `  game=${p.gameIndex} ply=${p.ply} blunderer=${p.blunderer} blunder=${p.blunderSan}\n` +
        `    fen: ${p.fenAfter}\n`,
    );
  }
  if (logger) {
    /* keep logger reference */
  }
}
