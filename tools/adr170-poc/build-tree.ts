/**
 * ADR-170 PoC (KS-5009) — конвейер дерева веток.
 *
 * Разовый скрипт (НЕ сервис). От тестовой позиции строит дерево ~20-40
 * веток: Maia policy (человеческие ходы выше порога вероятностной массы,
 * широко у корня) + Stockfish (сильнейшие ходы, если Maia не дала),
 * малая глубина. На каждую ветку сохраняет запись по схеме §4 ADR-170:
 *   root_fen, moves_uci, eval (Stockfish), outcome_prob (WDL),
 *   subterms (63+ подкомпоненты форк-trace, eval json, NNUE выкл),
 *   depth, stop_reason.
 * БЕЗ описаний и эмбеддингов — это следующая задача (фаза наполнения C).
 *
 * Инструменты:
 *   - Maia:  @kingside/maia-core + tools/maia3/maia3_simplified.onnx
 *   - Оценка/WDL/сильнейшие ходы: системный Stockfish 18 (/usr/games/stockfish)
 *   - trace 63 subterms: форк tools/stockfish-trace/src/stockfish (NNUE off)
 *
 * Запуск:  npx tsx tools/adr170-poc/build-tree.ts
 * Выход:   tools/adr170-poc/tree.json
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import {
  Maia,
  createNodeProvider,
  loadModelFromFs,
  type PredictResult,
} from '@kingside/maia-core';

// ---------------------------------------------------------------------------
// Конфигурация (пороги — эмпирические, §8 ADR-170).
// ---------------------------------------------------------------------------
const ROOT_FEN =
  process.env.ADR170_FEN ||
  'rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/5N2/PPP1BPPP/RNBQK2R b KQkq - 1 5';

const SF_BIN = '/usr/games/stockfish';
const TRACE_BIN =
  '/project/tools/stockfish-trace/src/stockfish';
const MAIA_MODEL = '/project/tools/maia3/maia3_simplified.onnx';
const MAIA_ELO = 1500; // «разумный» человеческий уровень для разброса планов
const OUT_PATH =
  process.env.ADR170_OUT || '/project/tools/adr170-poc/tree.json';

// Замер Stockfish+trace — ТОЛЬКО на листе линии, поэтому здесь можно дать
// нормальную глубину (листьев ~40, не сотни узлов).
const SF_DEPTH_LEAF = 16; // глубина Stockfish на конечной позиции линии
const SF_MULTIPV_ROOT = 3; // multipv в КОРНЕ (первые ходы ∪ Maia)

// §5.1 (ADR-170 рев.4)
const D_MAX = 12; // максимум полуходов в линии
const MAX_LINES = 40; // объём ≤40 линий
// Первые ходы (ply 1): Maia policy prob≥0.05, масса до 0.85, ≤6 ходов.
const ROOT_MAIA_PROB_MIN = 0.05;
const ROOT_MAIA_MASS = 0.85;
const ROOT_MAIA_MAX = 6;
// Развилки Maia top-2 на этих полуходах (по номеру хода в линии), иначе top-1.
const FORK_AT_MOVE = new Set([2, 4]);
// Стоп по стабильному исходу: Maia winProbability за/против стороны хода
// (прокси «одна из W/D/L > 90%», т.к. SF внутри линии не вызываем — §5.1 п.5).
const STABLE_WIN = 0.9;

// ---------------------------------------------------------------------------
// Stockfish 18: сильнейшие ходы + оценка (cp) + WDL для позиции.
// ---------------------------------------------------------------------------
interface SfMove {
  uci: string;
  cp: number | null; // от лица side-to-move
  mate: number | null;
  wdl: [number, number, number] | null; // W D L, per mille, side-to-move
}
interface SfResult {
  moves: SfMove[]; // отсортированы multipv 1..N (сильнейшие первыми)
  nodeCp: number | null;
  nodeMate: number | null;
  nodeWdl: [number, number, number] | null;
}

function runUci(
  bin: string,
  args: string[],
  setup: string[],
  go: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '';
    let done = false;
    p.stdout.on('data', (d) => {
      out += d.toString();
      if (!done && /^bestmove/m.test(out)) {
        done = true;
        p.stdin.write('quit\n');
      }
    });
    p.on('error', reject);
    p.on('close', () => resolve(out));
    for (const s of setup) p.stdin.write(s + '\n');
    p.stdin.write('isready\n');
    p.stdin.write(go + '\n');
  });
}

async function runSf(fen: string, multipv = 1): Promise<SfResult> {
  const out = await runUci(
    SF_BIN,
    [],
    [
      'uci',
      'setoption name UCI_ShowWDL value true',
      `setoption name MultiPV value ${multipv}`,
      `position fen ${fen}`,
    ],
    `go depth ${SF_DEPTH_LEAF}`,
  );
  // Берём последнюю (максимальную) глубину.
  const lines = out.split('\n').filter((l) => l.includes('multipv'));
  let maxDepth = -1;
  for (const l of lines) {
    const m = /info depth (\d+)/.exec(l);
    if (m) maxDepth = Math.max(maxDepth, parseInt(m[1], 10));
  }
  const byPv = new Map<number, SfMove>();
  for (const l of lines) {
    const dm = /info depth (\d+)/.exec(l);
    if (!dm || parseInt(dm[1], 10) !== maxDepth) continue;
    const pv = /multipv (\d+)/.exec(l);
    const pvMove = / pv ([a-h][0-9][a-h][0-9][qrbn]?)/.exec(l);
    if (!pv || !pvMove) continue;
    const cpM = /score cp (-?\d+)/.exec(l);
    const mateM = /score mate (-?\d+)/.exec(l);
    const wdlM = /wdl (\d+) (\d+) (\d+)/.exec(l);
    byPv.set(parseInt(pv[1], 10), {
      uci: pvMove[1],
      cp: cpM ? parseInt(cpM[1], 10) : null,
      mate: mateM ? parseInt(mateM[1], 10) : null,
      wdl: wdlM
        ? [parseInt(wdlM[1], 10), parseInt(wdlM[2], 10), parseInt(wdlM[3], 10)]
        : null,
    });
  }
  const moves = [...byPv.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const top = moves[0];
  return {
    moves,
    nodeCp: top?.cp ?? null,
    nodeMate: top?.mate ?? null,
    nodeWdl: top?.wdl ?? null,
  };
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
  // Агрегат по id, нетто с точки зрения белых (white - black), в pawn-units.
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
  // Извлекаем первый сбалансированный JSON-объект из вывода UCI.
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
// Ветки: перспектива белых.
// ---------------------------------------------------------------------------
function evalWhitePawns(
  fen: string,
  cp: number | null,
  mate: number | null,
): number | null {
  const white = fen.split(' ')[1] === 'w';
  if (mate !== null) {
    const m = white ? mate : -mate;
    return m > 0 ? 100 : -100; // mate — заглушка в pawn-units
  }
  if (cp === null) return null;
  const cpWhite = white ? cp : -cp;
  return Math.round(cpWhite) / 100;
}
function outcomeWhite(
  fen: string,
  wdl: [number, number, number] | null,
): { white: number; draw: number; black: number } | null {
  if (!wdl) return null;
  const white = fen.split(' ')[1] === 'w';
  const [w, d, l] = wdl.map((x) => x / 1000);
  return white
    ? { white: w, draw: d, black: l }
    : { white: l, draw: d, black: w };
}

// §5.1 шаг 2 — первые ходы: Maia policy (prob≥MIN, масса≤MASS, ≤MAX) ∪
// Stockfish multipv top-3 корня. Дедуп.
interface FirstMove {
  uci: string;
  maiaProb: number;
  source: ('maia' | 'sf')[];
}
function rootFirstMoves(maia: PredictResult | null, sf: SfResult): FirstMove[] {
  const map = new Map<string, FirstMove>();
  if (maia) {
    let mass = 0;
    let n = 0;
    for (const mv of maia.policy) {
      if (n >= ROOT_MAIA_MAX) break;
      if (mv.probability < ROOT_MAIA_PROB_MIN) break;
      map.set(mv.move, {
        uci: mv.move,
        maiaProb: mv.probability,
        source: ['maia'],
      });
      mass += mv.probability;
      n++;
      if (mass >= ROOT_MAIA_MASS) break;
    }
  }
  for (const m of sf.moves.slice(0, 3)) {
    const ex = map.get(m.uci);
    if (ex) {
      if (!ex.source.includes('sf')) ex.source.push('sf');
    } else {
      map.set(m.uci, {
        uci: m.uci,
        maiaProb: maia?.policy.find((p) => p.move === m.uci)?.probability ?? 0,
        source: ['sf'],
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
  source: ('maia' | 'sf')[];
  maia_prob: number | null; // вероятность последнего хода по Maia
  sf_rank: number | null; // ранг последнего хода в multipv, если из SF
  eval: number | null; // пешки, перспектива белых
  eval_cp_stm: number | null; // cp side-to-move (как отдал SF)
  mate: number | null;
  outcome_prob: { white: number; draw: number; black: number } | null;
  subterms: Record<string, { mg: number; eg: number }>;
  subterms_total: { mg: number; eg: number; v: number };
  subterms_raw: TraceEntry[];
}

let maia: Maia | null = null;
async function maiaPredict(fen: string): Promise<PredictResult | null> {
  if (!maia) return null;
  try {
    return await maia.predictMoves(fen, MAIA_ELO, MAIA_ELO);
  } catch (e) {
    console.warn('maia fail', (e as Error).message);
    return null;
  }
}

const branches: BranchRecord[] = [];

// §5.1 шаг 3–4 — ПЕРЕЧИСЛЕНИЕ линий по Maia (БЕЗ Stockfish внутри линии).
// Вглубь ведёт Maia top-1; на 2-м и 4-м полуходах — развилка Maia top-2.
// Стоп: D_max ИЛИ мат/пат ИЛИ стабильный исход (Maia winProbability за/против
// стороны хода ≥ STABLE_WIN — прокси «W или L >90%», SF внутри линии не зовём).
interface LeafLine {
  movesUci: string[];
  movesSan: string[];
  leafFen: string;
  ply: number;
  stop: string;
  pathProb: number; // произведение вероятностей ходов Maia (для отсечения §5.1 п.6)
  lastMaiaProb: number;
  firstSource: ('maia' | 'sf')[];
}
const leaves: LeafLine[] = [];

async function enumerateLine(
  fen: string,
  movesUci: string[],
  movesSan: string[],
  pathProb: number,
  lastMaiaProb: number,
  firstSource: ('maia' | 'sf')[],
): Promise<void> {
  const ply = movesUci.length;
  const over = new Chess(fen).isGameOver();
  const maiaRes = await maiaPredict(fen);
  const wp = maiaRes?.winProbability ?? null;
  const stable = wp != null && (wp >= STABLE_WIN || wp <= 1 - STABLE_WIN);
  const noMoves = !maiaRes || maiaRes.policy.length === 0;

  if (over || ply >= D_MAX || (stable && ply >= 1) || noMoves) {
    leaves.push({
      movesUci,
      movesSan,
      leafFen: fen,
      ply,
      stop: over
        ? 'terminal'
        : ply >= D_MAX
          ? 'max_depth'
          : stable
            ? 'stable_wdl'
            : 'no_moves',
      pathProb,
      lastMaiaProb,
      firstSource,
    });
    return;
  }

  const width = FORK_AT_MOVE.has(ply + 1) ? 2 : 1; // развилка на 2-м/4-м полуходе
  let any = false;
  for (const pick of maiaRes!.policy.slice(0, width)) {
    const g = new Chess(fen);
    let moved;
    try {
      moved = g.move(pick.move);
    } catch {
      continue;
    }
    if (!moved) continue;
    any = true;
    await enumerateLine(
      g.fen(),
      [...movesUci, pick.move],
      [...movesSan, moved.san],
      pathProb * pick.probability,
      pick.probability,
      firstSource,
    );
  }
  if (!any) {
    leaves.push({
      movesUci,
      movesSan,
      leafFen: fen,
      ply,
      stop: 'no_moves',
      pathProb,
      lastMaiaProb,
      firstSource,
    });
  }
}

// §5.1 шаг 5 — замер ТОЛЬКО на листе: Stockfish eval+WDL + форк trace.
async function measureLeaf(line: LeafLine): Promise<void> {
  const sf = await runSf(line.leafFen); // depth SF_DEPTH_LEAF, multipv 1
  const trace = await runTrace(line.leafFen);
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
    sf_rank: null,
    eval: evalWhitePawns(line.leafFen, sf.nodeCp, sf.nodeMate),
    eval_cp_stm: sf.nodeCp,
    mate: sf.nodeMate,
    outcome_prob: outcomeWhite(line.leafFen, sf.nodeWdl),
    subterms: trace.byId,
    subterms_total: trace.total,
    subterms_raw: trace.raw,
  });
  console.log(
    `  [${branches.length}] линия(${line.ply}, ${line.stop}): ${line.movesSan.join(' ')}  eval ${evalWhitePawns(line.leafFen, sf.nodeCp, sf.nodeMate)}`,
  );
}

async function expandTree(rootSf: SfResult): Promise<void> {
  const rootMaia = await maiaPredict(ROOT_FEN);
  const firsts = rootFirstMoves(rootMaia, rootSf);
  console.log(
    `первые ходы (Maia∪SF-top3): ${firsts.length} — ${firsts.map((f) => f.uci).join(', ')}`,
  );
  // Перечисляем линии от каждого первого хода (только Maia — дёшево).
  for (const fm of firsts) {
    const g = new Chess(ROOT_FEN);
    let moved;
    try {
      moved = g.move(fm.uci);
    } catch {
      continue;
    }
    if (!moved) continue;
    await enumerateLine(
      g.fen(),
      [fm.uci],
      [moved.san],
      Math.max(fm.maiaProb, 0.005),
      fm.maiaProb,
      fm.source,
    );
  }
  // §5.1 п.6 — объём ≤ MAX_LINES: отсекаем по вероятности пути Maia.
  leaves.sort((a, b) => b.pathProb - a.pathProb);
  const kept = leaves.slice(0, MAX_LINES);
  console.log(
    `перечислено линий: ${leaves.length}; оставляем ${kept.length} (по вероятности пути Maia). Замеряю SF+trace на листьях...`,
  );
  // §5.1 п.5 — Stockfish+trace ТОЛЬКО на листьях оставленных линий.
  for (const line of kept) await measureLeaf(line);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('ADR-170 PoC — построение дерева веток');
  console.log('root:', ROOT_FEN);

  // Maia init.
  try {
    maia = new Maia({
      provider: createNodeProvider(),
      fetchBuffer: () => loadModelFromFs(MAIA_MODEL),
    });
    await maia.ensureSession();
    console.log('Maia: сессия готова (ELO', MAIA_ELO + ')');
  } catch (e) {
    console.error('Maia init FAILED:', (e as Error).message);
    process.exit(1);
  }

  // Корневая позиция: multipv-SF (для первых ходов, §5.1 шаг 2) + baseline.
  const rootGame = new Chess(ROOT_FEN);
  const rootSf = await runSf(ROOT_FEN, SF_MULTIPV_ROOT);
  const rootTrace = await runTrace(ROOT_FEN);
  const baseline = {
    root_fen: ROOT_FEN,
    eval: evalWhitePawns(ROOT_FEN, rootSf.nodeCp, rootSf.nodeMate),
    outcome_prob: outcomeWhite(ROOT_FEN, rootSf.nodeWdl),
    subterms: rootTrace.byId,
    subterms_total: rootTrace.total,
  };
  void rootGame;

  await expandTree(rootSf);

  // Диагностика покрытия планов — по первому ходу ветки.
  const byFirstMove = new Map<string, number>();
  for (const b of branches) {
    const first = b.moves_san[0] ?? '(none)';
    byFirstMove.set(first, (byFirstMove.get(first) ?? 0) + 1);
  }

  const output = {
    meta: {
      adr: 'ADR-170 рев.4 §5.1',
      task: 'KS-5014',
      generated_note:
        'дерево по §5.1: первые ходы Maia∪SF-top3, вглубь Maia top-1 с развилками на 2-м/4-м полуходе, стоп D_max/мат/стабильный WDL; SF+trace только на листьях',
      root_fen: ROOT_FEN,
      maia_elo: MAIA_ELO,
      d_max: D_MAX,
      sf_depth_leaf: SF_DEPTH_LEAF,
      sf_multipv_root: SF_MULTIPV_ROOT,
      fork_at_moves: [...FORK_AT_MOVE],
      stable_win: STABLE_WIN,
      subterm_ids: SUBTERM_IDS,
      branch_count: branches.length,
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
    `\nГотово: ${branches.length} веток, ${byFirstMove.size} разных первых ходов`,
  );
  console.log('первые ходы:', [...byFirstMove.keys()].join(', '));
  console.log('файл:', OUT_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
