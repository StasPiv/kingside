/**
 * ADR-170 PoC (KS-5015) — конвейер дерева веток, рев.6.
 *
 * Разовый скрипт (НЕ сервис). От тестовой позиции строит дерево ~20-40 линий.
 * Ходы внутри дерева ведут ТОЛЬКО два тёплых процесса Lc0 (без Stockfish):
 *   - Maia-1500 (@kingside/maia-core) — человеческая policy;
 *   - сильная сеть Leela T1 256×10 (бинарь lc0) — «оракул», объективно
 *     сильнейший ход на узле, даже если Maia его недооценивает.
 * Продолжения узла = Maia top-1 ∪ Maia-ходы ≥ P_FORK ∪ ход-оракул Leela,
 * ширина ≤ MAX_WIDTH. Ход, вошедший только по оракулу (Maia < порога, не
 * top-1), помечается в engine_only_plies и защищён от отсечки по вероятности
 * пути Maia (§5.1 п.3, п.6 рев.6).
 *
 * Stockfish — ТОЛЬКО на листе (§5.1 п.5): eval + WDL и форк trace (63+
 * подкомпоненты, eval json, NNUE off) — сеть Leela разбиения не даёт.
 * WDL для стоп-условия внутри линии берётся у Leela (тёплый процесс).
 *
 * Запуск:  npx tsx tools/adr170-poc/build-tree.ts
 * Выход:   tools/adr170-poc/tree.json  (ADR170_OUT / ADR170_FEN — переопределяют)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import * as ort from 'onnxruntime-node';
// Прямой прогон Maia через onnxruntime-node: переиспользуем кодирование/декод
// maia-core (корректность сохранена), но минуем тяжёлый класс-обёртку —
// вызов падает со ~121мс до ~32мс (JS-обёртка нужна только фронту).
import {
  preprocessMaia3,
  postprocessMaia3,
  type PredictResult,
} from '@kingside/maia-core';

// ---------------------------------------------------------------------------
// Конфигурация (пороги — эмпирические, §8 ADR-170).
// ---------------------------------------------------------------------------
const ROOT_FEN =
  process.env.ADR170_FEN ||
  'rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/5N2/PPP1BPPP/RNBQK2R b KQkq - 1 5';

const TRACE_BIN = '/project/tools/stockfish-trace/src/stockfish';
const MAIA_MODEL = '/project/tools/maia3/maia3_simplified.onnx';
const MAIA_ELO = 1500; // «разумный» человеческий уровень для разброса планов
// Оракул Leela T1 — ONNX без поиска (рев.8): тёплый python-сервис.
const ORACLE_PY = '/project/tools/adr170-poc/leela-oracle.py';
const KS4989_LIBS = '/tmp/ks4989-libs';
const OUT_PATH =
  process.env.ADR170_OUT || '/project/tools/adr170-poc/tree.json';

// §5.1 рев.8: Stockfish go depth убран; на листе — только форк trace
// (eval = статическая оценка total.v, subterms), WDL — прогон Leela.

// §5.1 рев.7
const D_MAX = 12; // максимум полуходов в линии
const L_MAX = 40; // предел листьев (соблюдается В ХОДЕ обхода, §5.1 п.6)
// Первые ходы (ply 1): Maia policy prob≥0.05, масса до 0.85, ≤6 ходов ∪ Leela top-3.
const ROOT_MAIA_PROB_MIN = 0.05;
const ROOT_MAIA_MASS = 0.85;
const ROOT_MAIA_MAX = 6;
const ROOT_LEELA_MULTIPV = 3;
// Продолжения: Maia top-1 ∪ Maia≥P_FORK ∪ ход-оракул Leela; ширина ≤ MAX_WIDTH.
const P_FORK = 0.3;
const MAX_WIDTH = 4;
// Ограничение роста оракула (§5.1 п.3 рев.7).
const D_ORACLE = 6; // оракул добавляет ход только до этой глубины (полуходов)
const K_ORACLE = 2; // не более стольких оракульных отклонений на линию
// Стоп по стабильному исходу: одна из W/D/L сети Leela > STABLE (§5.1 п.4).
const STABLE_WIN = 0.9;
// Защита построителя (§5.1 п.7 рев.7): аварийные пределы + прогресс в лог.
const N_MAX = 1500; // максимум раскрытых узлов
const T_MAX_MS = 120000; // максимум времени обхода
const PROGRESS_EVERY = 50; // логировать прогресс раз в N узлов

// ---------------------------------------------------------------------------
// Оракул Leela T1 — ОДИН прогон ONNX без поиска (рев.8): тёплый python-сервис
// (leela-oracle.py), протокол «строка FEN → строка JSON». Голова политики +
// WDL стороны хода. Вызовы сериализованы (дерево строится последовательно).
// ---------------------------------------------------------------------------
interface LeelaResult {
  moves: { uci: string; prob: number }[]; // голова политики, сильнейшие первыми
  best: string | null; // argmax политики
  wdlTop: [number, number, number] | null; // доли [W,D,L], side-to-move
}

function toResult(line: string): LeelaResult {
  try {
    const d = JSON.parse(line) as {
      best?: string | null;
      wdl?: number[] | null;
      policy?: [string, number][];
      error?: string;
    };
    if (d.error) return { moves: [], best: null, wdlTop: null };
    return {
      moves: (d.policy ?? []).map(([uci, prob]) => ({ uci, prob })),
      best: d.best ?? null,
      wdlTop: (d.wdl as [number, number, number] | undefined) ?? null,
    };
  } catch {
    return { moves: [], best: null, wdlTop: null };
  }
}

class Leela {
  private proc: ChildProcessWithoutNullStreams;
  private out = '';
  private pending: ((v: LeelaResult) => void)[] = [];
  private readyRes: (() => void) | null = null;
  private ready: Promise<void>;

  constructor() {
    this.proc = spawn('python3', [ORACLE_PY], {
      env: { ...process.env, PYTHONPATH: KS4989_LIBS },
    });
    this.ready = new Promise((res) => (this.readyRes = res));
    this.proc.stderr.on('data', (d) => {
      if (/готов/.test(d.toString()) && this.readyRes) {
        this.readyRes();
        this.readyRes = null;
      }
    });
    this.proc.stdout.on('data', (d) => {
      this.out += d.toString();
      let nl: number;
      while ((nl = this.out.indexOf('\n')) >= 0) {
        const line = this.out.slice(0, nl);
        this.out = this.out.slice(nl + 1);
        const res = this.pending.shift();
        if (res) res(toResult(line));
      }
    });
    this.proc.on('error', (e) => {
      throw e;
    });
  }

  async init(): Promise<void> {
    await this.ready;
  }

  go(fen: string): Promise<LeelaResult> {
    return new Promise((res) => {
      this.pending.push(res);
      this.proc.stdin.write(fen + '\n');
    });
  }

  quit(): void {
    try {
      this.proc.stdin.write('quit\n');
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Форк trace: 63+ подкомпоненты (eval json, NNUE off).
// ---------------------------------------------------------------------------
interface TraceEntry {
  id: string;
  color: 'w' | 'b';
  square: string;
  value_mg: number;
  value_eg: number;
}
interface TraceResult {
  total: { mg: number; eg: number; v: number };
  raw: TraceEntry[];
  byId: Record<string, { mg: number; eg: number }>;
}

// Каноничный список id (порядок = subterm_id_names[] в форке).
const SUBTERM_IDS = [
  'pawn_doubled_early','pawn_connected','pawn_doubled','pawn_isolated','pawn_backward','pawn_lever_double','pawn_blocked',
  'king_shelter_strength','king_blocked_storm','king_unblocked_storm','king_on_file',
  'rook_on_king_ring','bishop_on_king_ring','knight_uncontested_outpost','outpost_knight','outpost_bishop','knight_reachable_outpost','minor_behind_pawn','knight_king_protector_distance','bishop_king_protector_distance','bishop_pawns','bishop_xray_pawns','bishop_long_diagonal','bishop_cornered','rook_on_open_file','rook_on_closed_file','rook_trapped','queen_weak',
  'king_safety_pawn','king_danger','king_safe_check_rook','king_safe_check_queen','king_safe_check_bishop','king_safe_check_knight','king_pawnless_flank','king_flank_attacks',
  'threat_by_minor','threat_by_rook','threat_by_king','threat_hanging','threat_weak_queen_protection','threat_restricted_piece','threat_by_safe_pawn','threat_by_pawn_push','threat_knight_on_queen','threat_slider_on_queen',
  'passed_rank','passed_king_proximity','passed_path_advance','passed_file_edge',
  'space',
  'psqt_pawn','psqt_knight','psqt_bishop','psqt_rook','psqt_queen','psqt_king',
  'mobility_knight','mobility_bishop','mobility_rook','mobility_queen','king_attackers_count','king_attackers_weight',
  'material','imbalance',
];

async function runTrace(fen: string): Promise<TraceResult> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(TRACE_BIN, []);
    let o = '';
    p.stdout.on('data', (d) => (o += d.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(o));
    p.stdin.write('setoption name Use NNUE value false\n');
    p.stdin.write(`position fen ${fen}\n`);
    p.stdin.write('eval json\n');
    p.stdin.write('quit\n');
  });
  const start = out.indexOf('{');
  const decoded: {
    total: { mg: number; eg: number; v: number };
    subterms: TraceEntry[];
  } = (() => {
    let depth = 0;
    for (let i = start; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) return JSON.parse(out.slice(start, i + 1));
      }
    }
    throw new Error('trace json not found for ' + fen);
  })();

  const byId: Record<string, { mg: number; eg: number }> = {};
  for (const id of SUBTERM_IDS) byId[id] = { mg: 0, eg: 0 };
  for (const e of decoded.subterms) {
    if (!byId[e.id]) byId[e.id] = { mg: 0, eg: 0 };
    const sign = e.color === 'w' ? 1 : -1;
    byId[e.id].mg += sign * e.value_mg;
    byId[e.id].eg += sign * e.value_eg;
  }
  return { total: decoded.total, raw: decoded.subterms, byId };
}

// ---------------------------------------------------------------------------
// Перспектива белых.
// ---------------------------------------------------------------------------
// Рев.8: eval листа = статическая оценка форк-trace total.v — она уже с точки
// зрения белых, в пешках (см. «Classical evaluation X (white side)»).
// WDL — доли [W,D,L] стороны хода от одного прогона Leela → в перспективу белых.
function outcomeWhite(
  fen: string,
  wdl: [number, number, number] | null,
): { white: number; draw: number; black: number } | null {
  if (!wdl) return null;
  const white = fen.split(' ')[1] === 'w';
  const [w, d, l] = wdl;
  return white
    ? { white: w, draw: d, black: l }
    : { white: l, draw: d, black: w };
}

// §5.1 шаг 2 — первые ходы: Maia policy (prob≥MIN, масса≤MASS, ≤MAX) ∪
// Leela top-3 (multipv). Дедуп.
interface FirstMove {
  uci: string;
  maiaProb: number;
  source: ('maia' | 'leela')[];
}
function rootFirstMoves(
  maia: PredictResult | null,
  leela: LeelaResult,
): FirstMove[] {
  const map = new Map<string, FirstMove>();
  if (maia) {
    let mass = 0;
    let n = 0;
    for (const mv of maia.policy) {
      if (n >= ROOT_MAIA_MAX) break;
      if (mv.probability < ROOT_MAIA_PROB_MIN) break;
      map.set(mv.move, { uci: mv.move, maiaProb: mv.probability, source: ['maia'] });
      mass += mv.probability;
      n++;
      if (mass >= ROOT_MAIA_MASS) break;
    }
  }
  for (const m of leela.moves.slice(0, ROOT_LEELA_MULTIPV)) {
    const ex = map.get(m.uci);
    if (ex) {
      if (!ex.source.includes('leela')) ex.source.push('leela');
    } else {
      map.set(m.uci, {
        uci: m.uci,
        maiaProb: maia?.policy.find((p) => p.move === m.uci)?.probability ?? 0,
        source: ['leela'],
      });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Обход дерева.
// ---------------------------------------------------------------------------
interface BranchRecord {
  id: string;
  root_fen: string;
  moves_uci: string[];
  moves_san: string[];
  leaf_fen: string;
  depth: number;
  stop_reason: string;
  source: ('maia' | 'leela')[];
  maia_prob: number | null; // вероятность последнего хода по Maia
  engine_only_plies: number[]; // полуходы (1-based), вошедшие только по оракулу Leela
  eval: number | null; // статическая оценка форк-trace (total.v), пешки, перспектива белых
  outcome_prob: { white: number; draw: number; black: number } | null; // WDL Leela, перспектива белых
  eval_static_note: string; // источник eval (рев.8: статика trace, не поиск)
  subterms: Record<string, { mg: number; eg: number }>;
  subterms_total: { mg: number; eg: number; v: number };
  subterms_raw: TraceEntry[];
}

let maiaSession: ort.InferenceSession | null = null;
let leela: Leela | null = null;

async function maiaPredict(fen: string): Promise<PredictResult | null> {
  if (!maiaSession) return null;
  try {
    const { boardTokens, legalMoves, blackToMove } = preprocessMaia3(fen);
    const feeds = {
      tokens: new ort.Tensor('float32', boardTokens, [1, 64, 12]),
      elo_self: new ort.Tensor('float32', Float32Array.from([MAIA_ELO]), [1]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from([MAIA_ELO]), [1]),
    };
    const out = await maiaSession.run(feeds);
    return postprocessMaia3(
      out.logits_move.data as Float32Array,
      out.logits_value.data as Float32Array,
      legalMoves,
      blackToMove,
    );
  } catch (e) {
    console.warn('maia fail', (e as Error).message);
    return null;
  }
}

const branches: BranchRecord[] = [];

// §5.1 шаг 3–4 (рев.6) — перечисление линий двумя тёплыми сетями Lc0.
interface LeafLine {
  movesUci: string[];
  movesSan: string[];
  leafFen: string;
  ply: number;
  stop: string;
  pathProb: number; // произведение вероятностей ходов Maia (для отсечки §5.1 п.6)
  lastMaiaProb: number;
  firstSource: ('maia' | 'leela')[];
  engineOnlyPlies: number[];
}
const leaves: LeafLine[] = [];

// Узел очереди best-first обхода (§5.1 п.3 рев.7).
interface QueueNode {
  fen: string;
  movesUci: string[];
  movesSan: string[];
  pathProb: number; // произведение вероятностей ходов Maia (для отсечки/записи)
  priority: number; // ключ best-first (оракульные рёбра приподняты, чтобы не тонуть)
  lastMaiaProb: number;
  firstSource: ('maia' | 'leela')[];
  engineOnlyPlies: number[];
}

// §5.1 шаг 5 (рев.8) — замер ТОЛЬКО на листе: eval = статическая оценка форк-
// trace (total.v), WDL — один прогон Leela; Stockfish go depth не запускается.
async function measureLeaf(line: LeafLine): Promise<void> {
  const trace = await runTrace(line.leafFen);
  const oracle = await leela!.go(line.leafFen);
  const evalWhite = trace.total.v;
  branches.push({
    id: `br${branches.length + 1}`,
    root_fen: ROOT_FEN,
    moves_uci: line.movesUci,
    moves_san: line.movesSan,
    leaf_fen: line.leafFen,
    depth: line.ply,
    stop_reason: line.stop,
    source: line.firstSource,
    maia_prob: line.lastMaiaProb,
    engine_only_plies: line.engineOnlyPlies,
    eval: evalWhite,
    outcome_prob: outcomeWhite(line.leafFen, oracle.wdlTop),
    eval_static_note: 'форк-trace total.v (статика, NNUE off); поиск не запускался (рев.8)',
    subterms: trace.byId,
    subterms_total: trace.total,
    subterms_raw: trace.raw,
  });
  console.log(
    `  [${branches.length}] линия(${line.ply}, ${line.stop}${line.engineOnlyPlies.length ? ', оракул@' + line.engineOnlyPlies.join(',') : ''}): ${line.movesSan.join(' ')}  eval ${evalWhite}`,
  );
}

async function expandTree(
  rootMaia: PredictResult | null,
  rootLeela: LeelaResult,
): Promise<void> {
  const firsts = rootFirstMoves(rootMaia, rootLeela);
  console.log(
    `первые ходы (Maia∪Leela-top3): ${firsts.length} — ${firsts.map((f) => f.uci).join(', ')}`,
  );
  const queue: QueueNode[] = [];
  for (const fm of firsts) {
    const g = new Chess(ROOT_FEN);
    let moved;
    try {
      moved = g.move(fm.uci);
    } catch {
      continue;
    }
    if (!moved) continue;
    // Первый ход из оракула (Maia ниже порога) — тоже помечаем как engine-only.
    const engineOnly = fm.source.length === 1 && fm.source[0] === 'leela';
    const pp = Math.max(fm.maiaProb, 0.005);
    queue.push({
      fen: g.fen(),
      movesUci: [fm.uci],
      movesSan: [moved.san],
      pathProb: pp,
      priority: engineOnly ? pp * 0.5 : pp,
      lastMaiaProb: fm.maiaProb,
      firstSource: fm.source,
      engineOnlyPlies: engineOnly ? [1] : [],
    });
  }

  // §5.1 п.3, п.7 (рев.7) — best-first обход по вероятности пути Maia с жёсткими
  // пределами (N_max/T_max/L_max) и периодическим прогрессом в лог.
  const start = Date.now();
  let expanded = 0;
  let maxDepth = 0;
  let stopReason = '';
  const oracleLeaves = () =>
    leaves.filter((l) => l.engineOnlyPlies.length > 0).length;
  const progress = () =>
    console.log(
      `  …обход: раскрыто ${expanded}, листьев ${leaves.length} (оракульных ${oracleLeaves()}), макс.глубина ${maxDepth}, очередь ${queue.length}, ${Math.round((Date.now() - start) / 1000)}c`,
    );

  while (queue.length > 0) {
    if (leaves.length >= L_MAX) {
      stopReason = 'L_max';
      break;
    }
    if (expanded >= N_MAX) {
      stopReason = 'N_max';
      break;
    }
    if (Date.now() - start > T_MAX_MS) {
      stopReason = 'T_max';
      break;
    }

    // best-first: вынуть узел с максимальным priority.
    let bi = 0;
    for (let i = 1; i < queue.length; i++)
      if (queue[i].priority > queue[bi].priority) bi = i;
    const node = queue.splice(bi, 1)[0];
    expanded++;
    if (node.movesUci.length > maxDepth) maxDepth = node.movesUci.length;

    const ply = node.movesUci.length;
    const over = new Chess(node.fen).isGameOver();
    const maiaRes = await maiaPredict(node.fen);
    const oracle = await leela!.go(node.fen);
    const wdl = oracle.wdlTop; // доли side-to-move
    const stable =
      wdl != null && Math.max(wdl[0], wdl[1], wdl[2]) > STABLE_WIN;
    const policy = maiaRes?.policy ?? [];
    const noMoves = policy.length === 0 && !oracle.best;

    if (over || ply >= D_MAX || (stable && ply >= 1) || noMoves) {
      leaves.push({
        movesUci: node.movesUci,
        movesSan: node.movesSan,
        leafFen: node.fen,
        ply,
        stop: over
          ? 'terminal'
          : ply >= D_MAX
            ? 'max_depth'
            : stable
              ? 'stable_wdl'
              : 'no_moves',
        pathProb: node.pathProb,
        lastMaiaProb: node.lastMaiaProb,
        firstSource: node.firstSource,
        engineOnlyPlies: node.engineOnlyPlies,
      });
      if (expanded % PROGRESS_EVERY === 0) progress();
      continue;
    }

    // Продолжения (§5.1 п.3 рев.7): Maia top-1 всегда; развилки Maia≥P_FORK и
    // ход-оракул — только до D_ORACLE и не более K_ORACLE отклонений на линию.
    const maiaTop = policy[0]?.move ?? null;
    const beyondOracle = ply + 1 > D_ORACLE;
    const oracleUsed = node.engineOnlyPlies.length;
    const picks = new Map<
      string,
      { uci: string; maiaProb: number; engineOnly: boolean }
    >();
    const add = (uci: string, engineOnly: boolean) => {
      const ex = picks.get(uci);
      if (ex) {
        if (!engineOnly) ex.engineOnly = false;
        return;
      }
      const mp = policy.find((p) => p.move === uci)?.probability ?? 0;
      picks.set(uci, { uci, maiaProb: mp, engineOnly });
    };
    if (maiaTop) add(maiaTop, false);
    if (!beyondOracle) {
      for (const p of policy) if (p.probability >= P_FORK) add(p.move, false);
      if (oracle.best && oracleUsed < K_ORACLE) {
        const mp = policy.find((p) => p.move === oracle.best)?.probability ?? 0;
        add(oracle.best, oracle.best !== maiaTop && mp < P_FORK);
      }
    }
    // за пределом D_ORACLE — только Maia top-1 (реализация плана)

    const rank = (x: { uci: string; engineOnly: boolean }) =>
      x.uci === maiaTop ? 0 : x.engineOnly ? 1 : 2;
    const capped = [...picks.values()]
      .sort((a, b) => rank(a) - rank(b) || b.maiaProb - a.maiaProb)
      .slice(0, MAX_WIDTH);

    for (const pick of capped) {
      const g = new Chess(node.fen);
      let moved;
      try {
        moved = g.move(pick.uci);
      } catch {
        continue;
      }
      if (!moved) continue;
      const childPath = node.pathProb * Math.max(pick.maiaProb, 0.001);
      // Оракульное ребро наследует приоритет родителя (иначе тонет из-за низкой
      // вероятности Maia и не будет раскрыто до предела листьев).
      const childPriority = pick.engineOnly ? node.priority * 0.5 : childPath;
      queue.push({
        fen: g.fen(),
        movesUci: [...node.movesUci, pick.uci],
        movesSan: [...node.movesSan, moved.san],
        pathProb: childPath,
        priority: childPriority,
        lastMaiaProb: pick.maiaProb,
        firstSource: node.firstSource,
        engineOnlyPlies: pick.engineOnly
          ? [...node.engineOnlyPlies, ply + 1]
          : node.engineOnlyPlies,
      });
    }
    if (expanded % PROGRESS_EVERY === 0) progress();
  }

  progress();
  if (stopReason)
    console.log(
      `  ⚠ остановка обхода по пределу: ${stopReason} (раскрыто ${expanded}, листьев ${leaves.length}, ${Math.round((Date.now() - start) / 1000)}c)`,
    );

  // §5.1 п.6 — предел листьев соблюдён в ходе обхода; финальная отсечка с
  // защитой оракульных линий (на случай, если листьев >L_MAX из-за ширины).
  const protectedL = leaves.filter((l) => l.engineOnlyPlies.length > 0);
  const rest = leaves
    .filter((l) => l.engineOnlyPlies.length === 0)
    .sort((a, b) => b.pathProb - a.pathProb);
  const slots = Math.max(0, L_MAX - protectedL.length);
  const kept = [...protectedL, ...rest.slice(0, slots)].sort(
    (a, b) => b.pathProb - a.pathProb,
  );
  console.log(
    `перечислено листьев: ${leaves.length} (с оракулом: ${protectedL.length}); оставляем ${kept.length}. Замеряю SF+trace...`,
  );
  for (const line of kept) await measureLeaf(line);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('ADR-170 PoC рев.8 — построение дерева веток');
  console.log('root:', ROOT_FEN);

  // Maia init — прямая сессия onnxruntime-node (без класс-обёртки maia-core).
  try {
    maiaSession = await ort.InferenceSession.create(MAIA_MODEL);
    console.log('Maia: сессия готова (прямой прогон, ELO', MAIA_ELO + ')');
  } catch (e) {
    console.error('Maia init FAILED:', (e as Error).message);
    process.exit(1);
  }

  // Leela T1 init (тёплый python-оракул ONNX, без поиска).
  try {
    leela = new Leela();
    await leela.init();
    console.log('Leela T1: тёплый onnx-оракул готов');
  } catch (e) {
    console.error('Leela init FAILED:', (e as Error).message);
    process.exit(1);
  }

  // Корень: Maia policy + Leela top-3 головы политики (первые ходы, §5.1 шаг 2).
  const rootMaia = await maiaPredict(ROOT_FEN);
  const rootLeela = await leela.go(ROOT_FEN);

  // baseline корня (для отчёта): eval = статика форк-trace, WDL — Leela.
  const rootTrace = await runTrace(ROOT_FEN);
  const baseline = {
    root_fen: ROOT_FEN,
    eval: rootTrace.total.v,
    outcome_prob: outcomeWhite(ROOT_FEN, rootLeela.wdlTop),
    subterms: rootTrace.byId,
    subterms_total: rootTrace.total,
  };

  await expandTree(rootMaia, rootLeela);
  leela.quit();

  // Диагностика покрытия планов — по первому ходу ветки.
  const byFirstMove = new Map<string, number>();
  for (const b of branches) {
    const first = b.moves_san[0] ?? '(none)';
    byFirstMove.set(first, (byFirstMove.get(first) ?? 0) + 1);
  }
  const oracleLines = branches.filter((b) => b.engine_only_plies.length > 0);

  const output = {
    meta: {
      adr: 'ADR-170 рев.8 §5.1',
      task: 'KS-5015',
      generated_note:
        'дерево по §5.1 рев.8: оракул Leela T1 — ОДИН прогон ONNX (голова политики, БЕЗ поиска); первые ходы Maia∪Leela-top3; продолжения Maia top-1 ∪ Maia≥P_fork ∪ ход-оракул (ширина ≤4), оракул до D_oracle и ≤K_oracle на линию; best-first обход по вероятности пути Maia с пределами N_max/T_max/L_max; ходы оракула помечены engine_only_plies и защищены от отсечки; стоп D_max/мат/WDL Leela>90%; лист: eval=статика форк-trace total.v, WDL=Leela, Stockfish go depth не запускается',
      root_fen: ROOT_FEN,
      maia_elo: MAIA_ELO,
      leela_net: '/project/.agent-tmp/t1-256x10.onnx (голова политики, без поиска)',
      d_max: D_MAX,
      d_oracle: D_ORACLE,
      k_oracle: K_ORACLE,
      n_max: N_MAX,
      t_max_ms: T_MAX_MS,
      l_max: L_MAX,
      p_fork: P_FORK,
      max_width: MAX_WIDTH,
      stable_win: STABLE_WIN,
      subterm_ids: SUBTERM_IDS,
      branch_count: branches.length,
      oracle_line_count: oracleLines.length,
      distinct_first_moves: [...byFirstMove.entries()].map(([m, n]) => ({
        move: m,
        branches: n,
      })),
    },
    baseline,
    branches,
  };
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(
    `\nГотово: ${branches.length} веток (${oracleLines.length} с ход-оракулом), ${byFirstMove.size} разных первых ходов`,
  );
  console.log('первые ходы:', [...byFirstMove.keys()].join(', '));
  console.log('файл:', OUT_PATH);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
