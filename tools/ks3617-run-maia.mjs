#!/usr/bin/env node
/**
 * KS-3617. CLI-обёртка над Maia-3 (ONNX через onnxruntime-node).
 * Для FEN на выбранном ELO отдаёт top-N легальных ходов с probability.
 *
 * Использование:
 *   node tools/ks3617-run-maia.mjs --fen "<FEN>" [--elo 1500] [--top 5]
 *
 * Препроцессинг и пост-процессинг — копия алгоритма из
 * `apps/web/src/lib/maia/{tensor,engine}.ts`, заинлайнен здесь, чтобы
 * скрипт работал без TS-тулчейна.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';

// Модули onnxruntime-node и chess.js установлены в apps/web/node_modules
// (workspaces NPM кладёт туда). createRequire с базой = apps/web даёт
// доступ к ним и из любого cwd.
const requireFromWeb = createRequire(
  resolvePath(process.cwd(), 'apps/web/package.json'),
);
const ort = requireFromWeb('onnxruntime-node');
const { Chess } = requireFromWeb('chess.js');

const allMovesDict = JSON.parse(
  await readFile(
    resolvePath(
      process.cwd(),
      'apps/web/src/lib/maia/data/all_moves_maia3.json',
    ),
    'utf8',
  ),
);
const allMovesReversedDict = JSON.parse(
  await readFile(
    resolvePath(
      process.cwd(),
      'apps/web/src/lib/maia/data/all_moves_maia3_reversed.json',
    ),
    'utf8',
  ),
);

const MODEL_PATH = resolvePath(
  process.cwd(),
  'apps/web/public/maia3/maia3_simplified.onnx',
);
const MAIA3_VOCAB_SIZE = Object.keys(allMovesDict).length;

function parseArgs(argv) {
  const out = { fen: null, elo: 1500, top: 5 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fen') out.fen = argv[++i];
    else if (a === '--elo') out.elo = Number(argv[++i]);
    else if (a === '--top') out.top = Number(argv[++i]);
  }
  if (!out.fen) {
    process.stderr.write('usage: ks3617-run-maia.mjs --fen <FEN> [--elo N] [--top N]\n');
    process.exit(2);
  }
  return out;
}

// --- препроцессинг (адаптация tensor.ts) -----------------------------------
function mirrorSquare(sq) {
  return sq[0] + (9 - +sq[1]);
}
function mirrorMove(uci) {
  const promo = uci.length > 4 ? uci.slice(4) : '';
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + promo;
}
function swapColorsInRank(rank) {
  let out = '';
  for (const c of rank) {
    if (/[A-Z]/.test(c)) out += c.toLowerCase();
    else if (/[a-z]/.test(c)) out += c.toUpperCase();
    else out += c;
  }
  return out;
}
function swapCastling(c) {
  if (c === '-') return '-';
  const r = new Set(c.split(''));
  const s = new Set();
  if (r.has('K')) s.add('k');
  if (r.has('Q')) s.add('q');
  if (r.has('k')) s.add('K');
  if (r.has('q')) s.add('Q');
  return ['K', 'Q', 'k', 'q'].filter((x) => s.has(x)).join('') || '-';
}
function mirrorFen(fen) {
  const [pos, color, cast, ep, hm, fm] = fen.split(' ');
  const ranks = pos
    .split('/')
    .reverse()
    .map(swapColorsInRank)
    .join('/');
  return `${ranks} ${color === 'w' ? 'b' : 'w'} ${swapCastling(cast)} ${ep !== '-' ? mirrorSquare(ep) : '-'} ${hm} ${fm}`;
}
function boardToTokens(fen) {
  const pieces = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
  const out = new Float32Array(64 * 12);
  const rows = fen.split(' ')[0].split('/');
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank;
    let file = 0;
    for (const ch of rows[rank]) {
      if (!/\d/.test(ch)) {
        const idx = pieces.indexOf(ch);
        if (idx >= 0) out[(row * 8 + file) * 12 + idx] = 1;
        file++;
      } else {
        file += +ch;
      }
    }
  }
  return out;
}
function preprocess(fen) {
  const stm = fen.split(' ')[1];
  const blackToMove = stm === 'b';
  let board = new Chess(fen);
  if (blackToMove) board = new Chess(mirrorFen(board.fen()));
  const tokens = boardToTokens(board.fen());
  const legal = new Float32Array(MAIA3_VOCAB_SIZE);
  for (const m of board.moves({ verbose: true })) {
    const uci = m.from + m.to + (m.promotion || '');
    const idx = allMovesDict[uci];
    if (idx !== undefined) legal[idx] = 1;
  }
  return { tokens, legal, blackToMove };
}

// --- пост-процессинг -------------------------------------------------------
function postprocess(logitsMove, logitsValue, legal, blackToMove) {
  // WDL value
  const max3 = Math.max(logitsValue[0], logitsValue[1], logitsValue[2]);
  const eL = Math.exp(logitsValue[0] - max3);
  const eD = Math.exp(logitsValue[1] - max3);
  const eW = Math.exp(logitsValue[2] - max3);
  const sum3 = eL + eD + eW;
  let winProb = (eW + 0.5 * eD) / sum3;
  if (blackToMove) winProb = 1 - winProb;

  // Softmax по легальным
  const legalIdx = [];
  for (let i = 0; i < legal.length; i++) if (legal[i] > 0) legalIdx.push(i);
  if (legalIdx.length === 0) return { policy: [], winProbability: winProb };

  let maxL = -Infinity;
  for (const i of legalIdx) if (logitsMove[i] > maxL) maxL = logitsMove[i];
  const exps = new Float32Array(legalIdx.length);
  let s = 0;
  for (let i = 0; i < legalIdx.length; i++) {
    const v = Math.exp(logitsMove[legalIdx[i]] - maxL);
    exps[i] = v;
    s += v;
  }
  const policy = legalIdx.map((idx, i) => {
    let uci = allMovesReversedDict[idx];
    if (blackToMove) uci = mirrorMove(uci);
    return { move: uci, probability: exps[i] / s };
  });
  policy.sort((a, b) => b.probability - a.probability);
  return { policy, winProbability: winProb };
}

// --- main ------------------------------------------------------------------
const args = parseArgs(process.argv);
const buf = await readFile(MODEL_PATH);
const session = await ort.InferenceSession.create(buf, {
  executionProviders: ['cpu'],
});

const { tokens, legal, blackToMove } = preprocess(args.fen);
const feeds = {
  tokens: new ort.Tensor('float32', tokens, [1, 64, 12]),
  elo_self: new ort.Tensor('float32', Float32Array.from([args.elo]), [1]),
  elo_oppo: new ort.Tensor('float32', Float32Array.from([args.elo]), [1]),
};
const out = await session.run(feeds);
const logitsMove = out.logits_move.data;
const logitsValue = out.logits_value.data;
const { policy, winProbability } = postprocess(
  logitsMove,
  logitsValue,
  legal,
  blackToMove,
);

process.stdout.write(
  JSON.stringify(
    {
      fen: args.fen,
      elo: args.elo,
      winProbability,
      top: policy.slice(0, args.top),
    },
    null,
    2,
  ) + '\n',
);
