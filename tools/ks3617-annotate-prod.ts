/**
 * KS-3617. Валидатор, использующий **прод-код** напрямую:
 *   buildAnnotation + applyAnnotationsToPgn из apps/web/src/lib/review/.
 * Только движки (Stockfish + Maia) живут здесь, в CLI. Логика
 * классификации/NAG/вариантов/PGN-сериализации — ровно та, что в
 * браузерной сборке.
 *
 * Запуск:
 *   /project/apps/web/node_modules/.bin/tsx tools/ks3617-annotate-prod.ts \
 *     --pgn <file> [--depth 18] [--elo 1500]
 */
import { spawn } from 'node:child_process';
import { readFile, readFile as _readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { Chess } from 'chess.js';

// Прод-модули: ровно тот же код, что в браузере.
import {
  buildAnnotation,
  type MoveInput,
  type Annotation,
} from '../apps/web/src/lib/review/buildAnnotations';
import { applyAnnotationsToPgn } from '../apps/web/src/lib/review/applyAnnotationsToPgn';

import type { Wdl } from '@kingside/shared';

// --- onnxruntime-node + Maia data через CJS require -----------------------
const requireFromWeb = createRequire(
  resolvePath(process.cwd(), 'apps/web/package.json'),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ort: any = requireFromWeb('onnxruntime-node');

const allMovesDict = JSON.parse(
  readFileSync(
    resolvePath(
      process.cwd(),
      'apps/web/src/lib/maia/data/all_moves_maia3.json',
    ),
    'utf8',
  ),
) as Record<string, number>;
const allMovesReversed = JSON.parse(
  readFileSync(
    resolvePath(
      process.cwd(),
      'apps/web/src/lib/maia/data/all_moves_maia3_reversed.json',
    ),
    'utf8',
  ),
) as Record<string, string>;
const MAIA_VOCAB_SIZE = Object.keys(allMovesDict).length;
const MODEL_PATH = resolvePath(
  process.cwd(),
  'apps/web/public/maia3/maia3_simplified.onnx',
);

const MAX_LINE_LENGTH_PLIES = 8;
const SUB_VARIATION_MAX_LENGTH_PLIES = 4;

// --- Stockfish persistent process -----------------------------------------
type SfLine = {
  multipv: number;
  bestUci: string | null;
  pv: string[];
  wdl: Wdl | null;
};
class Sf {
  private p = spawn('/usr/games/stockfish', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  private buf = '';
  private queue: Array<{ handle: (line: string) => void }> = [];
  constructor(public depth: number) {
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.p.stdin.write('uci\nsetoption name UCI_ShowWDL value true\n');
  }
  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.queue.length) this.queue[0].handle(line);
    }
  }
  analyze(
    fen: string,
    multipv = 3,
    searchmoves: string[] | null = null,
  ): Promise<SfLine[]> {
    return new Promise((resolve) => {
      const lines = new Map<number, { pv: string[]; wdl: Wdl | null }>();
      const job = {
        handle: (line: string) => {
          if (line.startsWith('info ') && line.includes(' pv ')) {
            const m = +((line.match(/\bmultipv (\d+)/) || [])[1] || 1);
            const pv = (line.match(/\bpv (.+)/) || [])[1]?.split(' ') ?? [];
            const wm = line.match(/\bwdl (\d+) (\d+) (\d+)/);
            lines.set(m, {
              pv,
              wdl: wm ? { w: +wm[1], d: +wm[2], l: +wm[3] } : null,
            });
          } else if (line.startsWith('bestmove')) {
            this.queue.shift();
            const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]);
            resolve(
              sorted.map(([mpv, v]) => ({
                multipv: mpv,
                bestUci: v.pv[0] ?? null,
                pv: v.pv,
                wdl: v.wdl,
              })),
            );
          }
        },
      };
      this.queue.push(job);
      const sm =
        searchmoves && searchmoves.length > 0
          ? ` searchmoves ${searchmoves.join(' ')}`
          : '';
      this.p.stdin.write(
        `ucinewgame\nsetoption name MultiPV value ${multipv}\nposition fen ${fen}\ngo depth ${this.depth}${sm}\n`,
      );
    });
  }
  close() {
    this.p.stdin.write('quit\n');
  }
}

// --- Maia inline (нужен только препроцессинг — engine.ts тоже мог бы,
//     но он зависит от DI-конфига; здесь короче inline). ----------------
function mirrorSq(s: string) {
  return s[0] + (9 - +s[1]);
}
function mirrorMove(u: string) {
  const p = u.length > 4 ? u.slice(4) : '';
  return mirrorSq(u.slice(0, 2)) + mirrorSq(u.slice(2, 4)) + p;
}
function swapColorsInRank(r: string) {
  let out = '';
  for (const c of r)
    out += /[A-Z]/.test(c)
      ? c.toLowerCase()
      : /[a-z]/.test(c)
        ? c.toUpperCase()
        : c;
  return out;
}
function swapCastling(c: string) {
  if (c === '-') return '-';
  const r = new Set(c);
  const s = new Set<string>();
  if (r.has('K')) s.add('k');
  if (r.has('Q')) s.add('q');
  if (r.has('k')) s.add('K');
  if (r.has('q')) s.add('Q');
  return ['K', 'Q', 'k', 'q'].filter((x) => s.has(x)).join('') || '-';
}
function mirrorFen(fen: string) {
  const [p, c, cs, ep, hm, fm] = fen.split(' ');
  const ranks = p.split('/').reverse().map(swapColorsInRank).join('/');
  return `${ranks} ${c === 'w' ? 'b' : 'w'} ${swapCastling(cs)} ${ep !== '-' ? mirrorSq(ep) : '-'} ${hm} ${fm}`;
}
function boardToTokens(fen: string) {
  const ps = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
  const out = new Float32Array(64 * 12);
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    const row = 7 - r;
    let file = 0;
    for (const c of rows[r]) {
      if (!/\d/.test(c)) {
        const i = ps.indexOf(c);
        if (i >= 0) out[(row * 8 + file) * 12 + i] = 1;
        file++;
      } else file += +c;
    }
  }
  return out;
}
function preprocess(fen: string) {
  const bt = fen.split(' ')[1] === 'b';
  let b = new Chess(fen);
  if (bt) b = new Chess(mirrorFen(b.fen()));
  const tokens = boardToTokens(b.fen());
  const legal = new Float32Array(MAIA_VOCAB_SIZE);
  for (const m of b.moves({ verbose: true })) {
    const i = allMovesDict[m.from + m.to + (m.promotion || '')];
    if (i !== undefined) legal[i] = 1;
  }
  return { tokens, legal, blackToMove: bt };
}
function postprocess(
  lm: Float32Array,
  legal: Float32Array,
  blackToMove: boolean,
) {
  const li: number[] = [];
  for (let i = 0; i < legal.length; i++) if (legal[i] > 0) li.push(i);
  if (!li.length) return [] as Array<{ move: string; probability: number }>;
  let maxL = -Infinity;
  for (const i of li) if (lm[i] > maxL) maxL = lm[i];
  const exps = new Float32Array(li.length);
  let s = 0;
  for (let i = 0; i < li.length; i++) {
    const v = Math.exp(lm[li[i]] - maxL);
    exps[i] = v;
    s += v;
  }
  const pol = li.map((idx, i) => {
    let u = allMovesReversed[idx];
    if (blackToMove) u = mirrorMove(u);
    return { move: u, probability: exps[i] / s };
  });
  pol.sort((a, b) => b.probability - a.probability);
  return pol;
}

// --- helpers ---------------------------------------------------------------
function applyMove(fen: string, uci: string): string | null {
  try {
    const b = new Chess(fen);
    const m = b.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m ? b.fen() : null;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]) {
  const out = { pgn: '', depth: 18, elo: 1500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pgn') out.pgn = argv[++i];
    else if (a === '--depth') out.depth = +argv[++i];
    else if (a === '--elo') out.elo = +argv[++i];
  }
  if (!out.pgn) {
    process.stderr.write('usage: --pgn <path>\n');
    process.exit(2);
  }
  return out;
}

// --- main ------------------------------------------------------------------
async function main() {
const args = parseArgs(process.argv);
const pgnText = await readFile(args.pgn, 'utf8');
const game = new Chess();
game.loadPgn(pgnText);
const history = game.history({ verbose: true });
const headers = game.header();
const replay = new Chess();
if (headers.SetUp === '1' && headers.FEN) {
  try {
    replay.load(headers.FEN);
  } catch {
    /* ignore */
  }
}

const sf = new Sf(args.depth);
const buf = await readFile(MODEL_PATH);
const session = await ort.InferenceSession.create(buf);

const moveInputs: MoveInput[] = [];
process.stderr.write(
  `Replaying ${history.length} half-moves (depth=${args.depth}, elo=${args.elo})...\n`,
);

for (let i = 0; i < history.length; i++) {
  const fen = replay.fen();
  const h = history[i];
  const playedUci = h.from + h.to + (h.promotion || '');
  const sfLines = await sf.analyze(fen, 3);
  const top = sfLines[0];
  const second = sfLines[1] ?? null;
  const wdlByMove: Record<string, Wdl> = {};
  for (const l of sfLines)
    if (l.bestUci && l.wdl) wdlByMove[l.bestUci] = l.wdl;

  const { tokens, legal, blackToMove } = preprocess(fen);
  const feeds = {
    tokens: new ort.Tensor('float32', tokens, [1, 64, 12]),
    elo_self: new ort.Tensor('float32', Float32Array.from([args.elo]), [1]),
    elo_oppo: new ort.Tensor('float32', Float32Array.from([args.elo]), [1]),
  };
  const out = await session.run(feeds);
  const policy = postprocess(
    out.logits_move.data as Float32Array,
    legal,
    blackToMove,
  );
  const m1 = policy[0] ?? null;

  let wdlAfterPlayed: Wdl;
  if (wdlByMove[playedUci]) wdlAfterPlayed = wdlByMove[playedUci];
  else {
    const ev = await sf.analyze(fen, 1, [playedUci]);
    wdlAfterPlayed = ev[0]?.wdl ?? top.wdl ?? { w: 500, d: 0, l: 500 };
  }
  const input: MoveInput = {
    ply: i + 1,
    fen,
    playedUci,
    sfBestUci: top.bestUci ?? '',
    wdlBefore: top.wdl ?? { w: 500, d: 0, l: 500 },
    wdlAfterPlayed,
    wdlAfterBest: top.wdl ?? { w: 500, d: 0, l: 500 },
    wdlAfterSecondBest: second?.wdl ?? null,
    wdlAfterMaiaTop: m1 ? wdlByMove[m1.move] : undefined,
    sfBestPv: top.pv,
    playedProb: policy.find((p) => p.move === playedUci)?.probability,
    sfBestProb: policy.find((p) => p.move === top.bestUci)?.probability,
    maiaTopUci: m1?.move ?? '',
    maiaTopProb: m1?.probability ?? 0,
    forcedMove: false,
  };
  moveInputs.push(input);
  try {
    replay.move({
      from: h.from,
      to: h.to,
      promotion: h.promotion,
    });
  } catch {
    break;
  }
  process.stderr.write(`  ply ${i + 1}/${history.length} done\n`);
}

// post-pass: subline (green из bestPv, red — отдельный SF от позиции после maiaTop).
for (const inp of moveInputs) {
  if (
    inp.sfBestUci &&
    inp.sfBestUci !== inp.playedUci &&
    inp.sfBestPv &&
    inp.sfBestPv.length > 1
  ) {
    inp.sfBestSubline = inp.sfBestPv.slice(1, MAX_LINE_LENGTH_PLIES);
  }
  if (inp.wdlAfterMaiaTop && inp.maiaTopUci) {
    const fenAfterMaia = applyMove(inp.fen, inp.maiaTopUci);
    if (fenAfterMaia) {
      const sub = await sf.analyze(fenAfterMaia, 1);
      const pv = sub[0]?.pv ?? [];
      if (pv.length)
        inp.maiaTopSubline = pv.slice(0, SUB_VARIATION_MAX_LENGTH_PLIES);
    }
  }
}

sf.close();

// === Вот тут — реальный прод-код ===
const annotations: Annotation[] = moveInputs.map(buildAnnotation);
const annotatedPgn = applyAnnotationsToPgn(pgnText, annotations);
process.stdout.write(annotatedPgn);

const sublineLens = annotations.flatMap((a) =>
  a.variations.map((v) => ({
    color: v.color,
    len: 1 + (v.subline?.length ?? 0),
  })),
);
const greenLens = sublineLens
  .filter((s) => s.color === 'green')
  .map((s) => s.len);
const redLens = sublineLens.filter((s) => s.color === 'red').map((s) => s.len);
process.stderr.write(`\n=== Summary (prod modules) ===\n`);
process.stderr.write(
  `Green (count=${greenLens.length}): lengths = ${JSON.stringify(greenLens)}\n`,
);
process.stderr.write(
  `Red   (count=${redLens.length}): lengths = ${JSON.stringify(redLens)}\n`,
);
process.stderr.write(
  `NAGs: ${annotations.filter((a) => a.nag.length).length} of ${annotations.length}\n`,
);
}
main().catch((e) => { console.error(e); process.exit(1); });
