#!/usr/bin/env node
/**
 * KS-3617. Прогон PGN полуходно через системный Stockfish и Maia-3
 * (onnxruntime-node). Для каждого полухода печатает строку таблицы:
 *
 *   ply  played  sfBest  signedBefore  sfPvLen  maiaTop  maiaProb  decided?
 *
 * `decided?` — флаг по §3.3 ADR-100: |signed(wdlBefore)| > 0.95.
 *
 * Использование:
 *   node tools/ks3617-replay.mjs --pgn <path> [--depth 18] [--elo 1500]
 *
 * Цель — собрать факты для KS-3617:
 *  - реальная длина sf.bestPv (от неё зависит длина зелёного варианта);
 *  - есть ли позиции с |signed| > 0.95 (suppress §3.3);
 *  - совпадает ли Maia top-1 с играным/sfBest (источник дублей nested).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';

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
const allMovesReversed = JSON.parse(
  await readFile(
    resolvePath(
      process.cwd(),
      'apps/web/src/lib/maia/data/all_moves_maia3_reversed.json',
    ),
    'utf8',
  ),
);
const MAIA_VOCAB_SIZE = Object.keys(allMovesDict).length;
const MODEL_PATH = resolvePath(
  process.cwd(),
  'apps/web/public/maia3/maia3_simplified.onnx',
);

function parseArgs(argv) {
  const out = { pgn: null, depth: 18, elo: 1500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pgn') out.pgn = argv[++i];
    else if (a === '--depth') out.depth = +argv[++i];
    else if (a === '--elo') out.elo = +argv[++i];
  }
  if (!out.pgn) {
    process.stderr.write('usage: ks3617-replay.mjs --pgn <path>\n');
    process.exit(2);
  }
  return out;
}

// --- Stockfish persistent process -----------------------------------------
class SfRunner {
  constructor(depth) {
    this.depth = depth;
    this.proc = spawn('/usr/games/stockfish', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buf = '';
    this.queue = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stdin.write('uci\nsetoption name UCI_ShowWDL value true\nsetoption name MultiPV value 3\nisready\n');
  }
  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.queue.length > 0) this.queue[0].handle(line);
    }
  }
  analyze(fen) {
    return new Promise((resolve) => {
      const lines = new Map();
      const job = {
        handle: (line) => {
          if (line.startsWith('info ') && line.includes(' pv ')) {
            const mpv = +((line.match(/\bmultipv (\d+)/) || [])[1] || 1);
            const pv = (line.match(/\bpv (.+)/) || [])[1]?.split(' ') ?? [];
            const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
            const wdl = wdlM ? { w: +wdlM[1], d: +wdlM[2], l: +wdlM[3] } : null;
            lines.set(mpv, { pv, wdl });
          } else if (line.startsWith('bestmove')) {
            this.queue.shift();
            const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]);
            resolve(
              sorted.map(([mpv, v]) => ({
                multipv: mpv,
                bestMove: v.pv[0],
                pv: v.pv,
                pvLen: v.pv.length,
                wdl: v.wdl,
                signed: v.wdl ? (v.wdl.w - v.wdl.l) / 1000 : null,
              })),
            );
          }
        },
      };
      this.queue.push(job);
      this.proc.stdin.write(`position fen ${fen}\ngo depth ${this.depth}\n`);
    });
  }
  close() {
    this.proc.stdin.write('quit\n');
  }
}

// --- Maia inline -----------------------------------------------------------
function mirrorSq(s) { return s[0] + (9 - +s[1]); }
function mirrorMove(uci) {
  const p = uci.length > 4 ? uci.slice(4) : '';
  return mirrorSq(uci.slice(0, 2)) + mirrorSq(uci.slice(2, 4)) + p;
}
function swapColorsInRank(r) {
  let out = '';
  for (const c of r) out += /[A-Z]/.test(c) ? c.toLowerCase() : /[a-z]/.test(c) ? c.toUpperCase() : c;
  return out;
}
function swapCastling(c) {
  if (c === '-') return '-';
  const r = new Set(c);
  const s = new Set();
  if (r.has('K')) s.add('k'); if (r.has('Q')) s.add('q');
  if (r.has('k')) s.add('K'); if (r.has('q')) s.add('Q');
  return ['K','Q','k','q'].filter(x => s.has(x)).join('') || '-';
}
function mirrorFen(fen) {
  const [pos, color, cast, ep, hm, fm] = fen.split(' ');
  const ranks = pos.split('/').reverse().map(swapColorsInRank).join('/');
  return `${ranks} ${color==='w'?'b':'w'} ${swapCastling(cast)} ${ep!=='-'?mirrorSq(ep):'-'} ${hm} ${fm}`;
}
function boardToTokens(fen) {
  const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
  const out = new Float32Array(64 * 12);
  const rows = fen.split(' ')[0].split('/');
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank;
    let file = 0;
    for (const ch of rows[rank]) {
      if (!/\d/.test(ch)) {
        const idx = pieces.indexOf(ch);
        if (idx >= 0) out[(row*8+file)*12 + idx] = 1;
        file++;
      } else file += +ch;
    }
  }
  return out;
}
function preprocess(fen) {
  const blackToMove = fen.split(' ')[1] === 'b';
  let board = new Chess(fen);
  if (blackToMove) board = new Chess(mirrorFen(board.fen()));
  const tokens = boardToTokens(board.fen());
  const legal = new Float32Array(MAIA_VOCAB_SIZE);
  for (const m of board.moves({ verbose: true })) {
    const idx = allMovesDict[m.from + m.to + (m.promotion || '')];
    if (idx !== undefined) legal[idx] = 1;
  }
  return { tokens, legal, blackToMove };
}
function postprocess(logitsMove, logitsValue, legal, blackToMove) {
  const max3 = Math.max(logitsValue[0], logitsValue[1], logitsValue[2]);
  const eL = Math.exp(logitsValue[0]-max3), eD = Math.exp(logitsValue[1]-max3), eW = Math.exp(logitsValue[2]-max3);
  const sum3 = eL + eD + eW;
  let winProb = (eW + 0.5*eD) / sum3;
  if (blackToMove) winProb = 1 - winProb;

  const legalIdx = [];
  for (let i = 0; i < legal.length; i++) if (legal[i] > 0) legalIdx.push(i);
  if (legalIdx.length === 0) return { policy: [], winProbability: winProb };
  let maxL = -Infinity;
  for (const i of legalIdx) if (logitsMove[i] > maxL) maxL = logitsMove[i];
  const exps = new Float32Array(legalIdx.length);
  let s = 0;
  for (let i = 0; i < legalIdx.length; i++) {
    const v = Math.exp(logitsMove[legalIdx[i]] - maxL);
    exps[i] = v; s += v;
  }
  const policy = legalIdx.map((idx, i) => {
    let uci = allMovesReversed[idx];
    if (blackToMove) uci = mirrorMove(uci);
    return { move: uci, probability: exps[i] / s };
  });
  policy.sort((a, b) => b.probability - a.probability);
  return { policy, winProbability: winProb };
}

class MaiaRunner {
  constructor(session, elo) { this.session = session; this.elo = elo; }
  async predict(fen) {
    const { tokens, legal, blackToMove } = preprocess(fen);
    const feeds = {
      tokens: new ort.Tensor('float32', tokens, [1, 64, 12]),
      elo_self: new ort.Tensor('float32', Float32Array.from([this.elo]), [1]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from([this.elo]), [1]),
    };
    const out = await this.session.run(feeds);
    return postprocess(out.logits_move.data, out.logits_value.data, legal, blackToMove);
  }
}

// --- main ------------------------------------------------------------------
const args = parseArgs(process.argv);
const pgnText = await readFile(args.pgn, 'utf8');

const game = new Chess();
game.loadPgn(pgnText);
const history = game.history({ verbose: true });

const replay = new Chess();
const headers = game.header();
if (headers.SetUp === '1' && headers.FEN) {
  try { replay.load(headers.FEN); } catch {}
}

const sf = new SfRunner(args.depth);
const buf = await readFile(MODEL_PATH);
const session = await ort.InferenceSession.create(buf);
const maia = new MaiaRunner(session, args.elo);

const rows = [];
process.stderr.write(`Processing ${history.length} half-moves at depth=${args.depth}, elo=${args.elo}...\n`);

for (let i = 0; i < history.length; i++) {
  const fen = replay.fen();
  const m = history[i];
  const playedUci = m.from + m.to + (m.promotion || '');

  const t0 = Date.now();
  const sfRes = await sf.analyze(fen);
  const top = sfRes[0];
  const maiaRes = await maia.predict(fen);
  const top1 = maiaRes.policy[0];
  const t1 = Date.now();

  const decided = top.signed != null && Math.abs(top.signed) > 0.95;
  const row = {
    ply: i + 1,
    side: fen.split(' ')[1],
    played: playedUci,
    sfBest: top.bestMove,
    sfBestSame: top.bestMove === playedUci,
    sfPvLen: top.pvLen,
    signedBefore: top.signed,
    decided,
    maiaTop: top1?.move ?? null,
    maiaProb: top1 ? Number(top1.probability.toFixed(3)) : null,
    maiaSameAsPlayed: top1?.move === playedUci,
    maiaSameAsSfBest: top1?.move === top.bestMove,
    elapsedMs: t1 - t0,
  };
  rows.push(row);
  process.stderr.write(
    `ply ${row.ply.toString().padStart(3)} | ${row.side} | played=${row.played} | sfBest=${row.sfBest} | sfPvLen=${row.sfPvLen.toString().padStart(2)} | signed=${row.signedBefore?.toFixed(3)} ${row.decided?'(DECIDED)':''} | maia=${row.maiaTop}(${row.maiaProb}) ${row.maiaSameAsPlayed?'=played':''}${row.maiaSameAsSfBest?'=sfBest':''} | ${row.elapsedMs}ms\n`,
  );

  try { replay.move({ from: m.from, to: m.to, promotion: m.promotion }); } catch { break; }
}

sf.close();

const stats = {
  total: rows.length,
  pvLenDistribution: rows.reduce((acc, r) => { acc[r.sfPvLen] = (acc[r.sfPvLen]||0)+1; return acc; }, {}),
  decidedCount: rows.filter(r => r.decided).length,
  maiaSameAsPlayedCount: rows.filter(r => r.maiaSameAsPlayed).length,
  maiaSameAsSfBestCount: rows.filter(r => r.maiaSameAsSfBest).length,
  playedNotBestCount: rows.filter(r => !r.sfBestSame).length,
};
process.stdout.write(JSON.stringify({ rows, stats }, null, 2) + '\n');
