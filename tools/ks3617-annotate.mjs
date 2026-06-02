#!/usr/bin/env node
/**
 * KS-3617. Прогоняет PGN через реальный SF + Maia, имитирует
 * `useGameReview` + `buildAnnotations` + `applyAnnotationsToPgn` с
 * предложенными правками (subline через `sf.bestPv.slice(1, 8)` для
 * green, отдельный SF-вызов для red). На выходе — аннотированный PGN.
 *
 * Использование:
 *   node tools/ks3617-annotate.mjs --pgn <path> [--depth 18] [--elo 1500]
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

// --- NAG / классификация ---------------------------------------------------
const NAG_GOOD = 1, NAG_MISTAKE = 2, NAG_BRILLIANT = 3, NAG_BLUNDER = 4;
const NAG_INTERESTING = 5, NAG_DUBIOUS = 6;
const NAG_SYMBOL = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };
const WDL_LOSS = { best: 0.02, good: 0.05, inaccuracy: 0.12, mistake: 0.25 };
const MATE_WDL = 950;
const DECIDED_WDL = 0.95;
const MAIA_ALT_MIN_PROB = 0.20;
const MAX_LINE_LENGTH_PLIES = 8;
const SUB_VARIATION_MAX_LENGTH_PLIES = 4;

function E(wdl) { return (wdl.w + wdl.d / 2) / 1000; }
function signed(wdl) { return (wdl.w - wdl.l) / 1000; }
function classifyMove({ wdlBefore, wdlAfter, isBestMove }) {
  if (isBestMove) return 'best';
  if (wdlAfter) {
    if (wdlAfter.l > MATE_WDL) return 'blunder';
    if (wdlAfter.w > MATE_WDL) return 'best';
  }
  const lossE = Math.max(0, E(wdlBefore) - E(wdlAfter));
  if (lossE <= WDL_LOSS.best) return 'best';
  if (lossE <= WDL_LOSS.good) return 'good';
  if (lossE <= WDL_LOSS.inaccuracy) return 'inaccuracy';
  if (lossE <= WDL_LOSS.mistake) return 'mistake';
  return 'blunder';
}
function pickNag(i, pc, sc) {
  if (i.forcedMove) return null;
  if (Math.abs(signed(i.wdlBefore)) > DECIDED_WDL) return null;
  const same = i.playedUci === i.sfBestUci;
  if (pc === 'blunder') return NAG_BLUNDER;
  if (pc === 'mistake') return NAG_MISTAKE;
  if (pc === 'inaccuracy') return NAG_DUBIOUS;
  if (pc === 'best' && same && i.playedProb !== undefined && i.playedProb < 0.05 &&
      (sc === 'mistake' || sc === 'blunder')) return NAG_BRILLIANT;
  if (pc === 'best' && same && i.playedProb !== undefined && i.playedProb < 0.20) return NAG_GOOD;
  if (pc === 'good' && !same && i.playedProb !== undefined && i.playedProb >= 0.30) return NAG_INTERESTING;
  return null;
}
function nagForMaiaTrap(c) {
  if (c === 'blunder') return NAG_BLUNDER;
  if (c === 'mistake') return NAG_MISTAKE;
  return null;
}

// --- Stockfish persistent ---------------------------------------------------
class Sf {
  constructor(depth) {
    this.depth = depth;
    this.p = spawn('/usr/games/stockfish', [], { stdio: ['pipe','pipe','pipe'] });
    this.buf = '';
    this.queue = [];
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (chunk) => this._on(chunk));
    this.p.stdin.write('uci\nsetoption name UCI_ShowWDL value true\n');
  }
  _on(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.queue.length) this.queue[0].handle(line);
    }
  }
  analyze(fen, multipv = 3) {
    return new Promise((resolve) => {
      const lines = new Map();
      const job = { handle: (line) => {
        if (line.startsWith('info ') && line.includes(' pv ')) {
          const m = +((line.match(/\bmultipv (\d+)/)||[])[1]||1);
          const pv = (line.match(/\bpv (.+)/)||[])[1]?.split(' ') ?? [];
          const wm = line.match(/\bwdl (\d+) (\d+) (\d+)/);
          lines.set(m, { pv, wdl: wm ? { w:+wm[1], d:+wm[2], l:+wm[3] } : null });
        } else if (line.startsWith('bestmove')) {
          this.queue.shift();
          const sorted = [...lines.entries()].sort((a,b)=>a[0]-b[0]);
          resolve(sorted.map(([mpv, v]) => ({
            multipv: mpv,
            bestUci: v.pv[0] ?? null,
            pv: v.pv,
            wdl: v.wdl,
          })));
        }
      }};
      this.queue.push(job);
      this.p.stdin.write(`ucinewgame\nsetoption name MultiPV value ${multipv}\nposition fen ${fen}\ngo depth ${this.depth}\n`);
    });
  }
  close() { this.p.stdin.write('quit\n'); }
}

// --- Maia inline -----------------------------------------------------------
function mirrorSq(s){ return s[0]+(9-+s[1]); }
function mirrorMove(u){ const p=u.length>4?u.slice(4):''; return mirrorSq(u.slice(0,2))+mirrorSq(u.slice(2,4))+p; }
function swapRank(r){ let o=''; for(const c of r) o += /[A-Z]/.test(c)?c.toLowerCase():/[a-z]/.test(c)?c.toUpperCase():c; return o; }
function swapCastling(c){ if(c==='-')return'-'; const r=new Set(c),s=new Set();
  if(r.has('K'))s.add('k'); if(r.has('Q'))s.add('q'); if(r.has('k'))s.add('K'); if(r.has('q'))s.add('Q');
  return ['K','Q','k','q'].filter(x=>s.has(x)).join('')||'-'; }
function mirrorFen(fen){ const[p,c,cs,ep,hm,fm]=fen.split(' ');
  const rs=p.split('/').reverse().map(swapRank).join('/');
  return `${rs} ${c==='w'?'b':'w'} ${swapCastling(cs)} ${ep!=='-'?mirrorSq(ep):'-'} ${hm} ${fm}`; }
function boardToTokens(fen){ const ps=['P','N','B','R','Q','K','p','n','b','r','q','k'];
  const out=new Float32Array(64*12); const rows=fen.split(' ')[0].split('/');
  for(let r=0;r<8;r++){ const row=7-r; let file=0;
    for(const c of rows[r]){ if(!/\d/.test(c)){ const i=ps.indexOf(c); if(i>=0)out[(row*8+file)*12+i]=1; file++; } else file+=+c; } }
  return out; }
function preprocess(fen){ const bt=fen.split(' ')[1]==='b'; let b=new Chess(fen);
  if(bt) b=new Chess(mirrorFen(b.fen())); const tokens=boardToTokens(b.fen());
  const legal=new Float32Array(MAIA_VOCAB_SIZE);
  for(const m of b.moves({verbose:true})){ const i=allMovesDict[m.from+m.to+(m.promotion||'')]; if(i!==undefined)legal[i]=1; }
  return { tokens, legal, blackToMove: bt }; }
function postprocess(lm, lv, legal, bt){
  const m3=Math.max(lv[0],lv[1],lv[2]); const eL=Math.exp(lv[0]-m3),eD=Math.exp(lv[1]-m3),eW=Math.exp(lv[2]-m3);
  const s3=eL+eD+eW; let wp=(eW+0.5*eD)/s3; if(bt) wp=1-wp;
  const li=[]; for(let i=0;i<legal.length;i++) if(legal[i]>0) li.push(i);
  if(!li.length) return { policy: [], winProbability: wp };
  let maxL=-Infinity; for(const i of li) if(lm[i]>maxL) maxL=lm[i];
  const exps=new Float32Array(li.length); let s=0;
  for(let i=0;i<li.length;i++){ const v=Math.exp(lm[li[i]]-maxL); exps[i]=v; s+=v; }
  const pol=li.map((idx,i)=>{ let u=allMovesReversed[idx]; if(bt) u=mirrorMove(u); return { move:u, probability: exps[i]/s }; });
  pol.sort((a,b)=>b.probability-a.probability);
  return { policy: pol, winProbability: wp };
}
class Maia { constructor(s,elo){ this.s=s; this.elo=elo; }
  async predict(fen){ const { tokens, legal, blackToMove } = preprocess(fen);
    const feeds = {
      tokens: new ort.Tensor('float32', tokens, [1,64,12]),
      elo_self: new ort.Tensor('float32', Float32Array.from([this.elo]), [1]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from([this.elo]), [1]),
    };
    const out = await this.s.run(feeds);
    return postprocess(out.logits_move.data, out.logits_value.data, legal, blackToMove);
  }
}

function applyMove(fen, uci) {
  try {
    const b = new Chess(fen);
    const m = b.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci.length>4?uci[4]:undefined });
    return m ? b.fen() : null;
  } catch { return null; }
}
function uciToSan(fen, uci) {
  try {
    const b = new Chess(fen);
    const m = b.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci.length>4?uci[4]:undefined });
    return m?.san ?? uci;
  } catch { return uci; }
}

// --- main ------------------------------------------------------------------
function parseArgs(argv) {
  const out = { pgn: null, depth: 18, elo: 1500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pgn') out.pgn = argv[++i];
    else if (a === '--depth') out.depth = +argv[++i];
    else if (a === '--elo') out.elo = +argv[++i];
  }
  if (!out.pgn) { process.stderr.write('usage: --pgn <path>\n'); process.exit(2); }
  return out;
}
const args = parseArgs(process.argv);
const pgnText = await readFile(args.pgn, 'utf8');

const game = new Chess();
game.loadPgn(pgnText);
const history = game.history({ verbose: true });
const headers = game.header();
const replay = new Chess();
if (headers.SetUp === '1' && headers.FEN) { try { replay.load(headers.FEN); } catch {} }

const sf = new Sf(args.depth);
const buf = await readFile(MODEL_PATH);
const session = await ort.InferenceSession.create(buf);
const maia = new Maia(session, args.elo);

const moveInputs = [];
process.stderr.write(`Replaying ${history.length} half-moves (depth=${args.depth}, elo=${args.elo})...\n`);

for (let i = 0; i < history.length; i++) {
  const fen = replay.fen();
  const h = history[i];
  const playedUci = h.from + h.to + (h.promotion || '');
  const sfLines = await sf.analyze(fen, 3);
  const top = sfLines[0];
  const second = sfLines[1] ?? null;
  const wdlByMove = {};
  for (const l of sfLines) if (l.bestUci && l.wdl) wdlByMove[l.bestUci] = l.wdl;
  const maiaRes = await maia.predict(fen);
  const m1 = maiaRes.policy[0] ?? null;
  let wdlAfterPlayed;
  if (wdlByMove[playedUci]) wdlAfterPlayed = wdlByMove[playedUci];
  else {
    const ev = await sf.analyze(fen, 1); // упрощённо: считаем все, иначе нужен searchmoves
    wdlAfterPlayed = ev[0]?.wdl ?? top.wdl;
  }
  const input = {
    ply: i + 1,
    fen,
    playedUci,
    sfBestUci: top.bestUci,
    wdlBefore: top.wdl,
    wdlAfterPlayed,
    wdlAfterBest: top.wdl,
    wdlAfterSecondBest: second?.wdl ?? null,
    wdlAfterMaiaTop: m1 ? wdlByMove[m1.move] : undefined,
    sfBestPv: top.pv,
    playedProb: maiaRes.policy.find(p => p.move === playedUci)?.probability,
    maiaTopUci: m1?.move ?? '',
    maiaTopProb: m1?.probability ?? 0,
    forcedMove: false,
  };
  moveInputs.push(input);
  try { replay.move({ from: h.from, to: h.to, promotion: h.promotion }); } catch { break; }
  process.stderr.write(`  ply ${i+1}/${history.length} done\n`);
}

// post-pass subline: green из sfBestPv, red — отдельный SF от позиции после maiaTop
for (const inp of moveInputs) {
  if (inp.sfBestUci && inp.sfBestUci !== inp.playedUci && inp.sfBestPv?.length > 1) {
    inp.sfBestSubline = inp.sfBestPv.slice(1, MAX_LINE_LENGTH_PLIES);
  }
  if (inp.wdlAfterMaiaTop && inp.maiaTopUci) {
    const fenAfterMaia = applyMove(inp.fen, inp.maiaTopUci);
    if (fenAfterMaia) {
      const sub = await sf.analyze(fenAfterMaia, 1);
      const pv = sub[0]?.pv ?? [];
      if (pv.length) inp.maiaTopSubline = pv.slice(0, SUB_VARIATION_MAX_LENGTH_PLIES);
    }
  }
}

sf.close();

// buildAnnotation для каждого input
function buildAnnotation(input) {
  const playedClass = classifyMove({
    wdlBefore: input.wdlBefore, wdlAfter: input.wdlAfterPlayed,
    isBestMove: input.playedUci === input.sfBestUci,
  });
  const secondBestClass = input.wdlAfterSecondBest
    ? classifyMove({ wdlBefore: input.wdlBefore, wdlAfter: input.wdlAfterSecondBest })
    : null;
  const maiaTopClass = input.wdlAfterMaiaTop
    ? classifyMove({ wdlBefore: input.wdlBefore, wdlAfter: input.wdlAfterMaiaTop })
    : null;
  const nag = pickNag(input, playedClass, secondBestClass);
  const variations = [];
  if ((playedClass === 'mistake' || playedClass === 'blunder') && input.sfBestUci !== input.playedUci) {
    variations.push({
      uci: input.sfBestUci, color: 'green',
      subline: input.sfBestSubline ?? input.sfBestPv.slice(1, 3),
    });
  }
  if (maiaTopClass && input.maiaTopUci !== input.sfBestUci && input.maiaTopUci !== input.playedUci &&
      input.maiaTopProb >= MAIA_ALT_MIN_PROB && maiaTopClass !== 'best') {
    const n = nagForMaiaTrap(maiaTopClass);
    variations.push({
      uci: input.maiaTopUci, color: 'red',
      subline: input.maiaTopSubline,
      nag: n != null ? [n] : undefined,
    });
  }
  return { ply: input.ply, nag: nag != null ? [nag] : [], variations };
}

const annotations = moveInputs.map(buildAnnotation);

// --- сериализатор PGN -------------------------------------------------------
function buildVariationText(startFen, v) {
  const ucis = [v.uci, ...(v.subline ?? [])];
  const sans = [];
  let cur = startFen;
  for (const u of ucis) {
    const b = new Chess(cur);
    const m = b.move({ from: u.slice(0,2), to: u.slice(2,4), promotion: u.length>4?u[4]:undefined });
    if (!m) return '';
    sans.push(m.san); cur = b.fen();
  }
  const isWhite = startFen.split(' ')[1] === 'w';
  const fullMove = +(startFen.split(' ')[5] ?? '1');
  const toks = [];
  let wp = isWhite, mn = fullMove;
  for (let i = 0; i < sans.length; i++) {
    if (wp) toks.push(`${mn}.`); else if (i === 0) toks.push(`${mn}...`);
    const suf = i === 0 && v.nag?.length ? (NAG_SYMBOL[v.nag[0]] ?? '') : '';
    toks.push(sans[i] + suf);
    if (wp) wp = false; else { mn++; wp = true; }
  }
  toks.push(`{[%cvc ${v.color}]}`);
  return toks.join(' ');
}

function applyAnnotationsToPgn(pgn, anns) {
  const byPly = new Map();
  for (const a of anns) byPly.set(a.ply, a);
  const chess = new Chess();
  chess.loadPgn(pgn);
  const h = chess.header();
  const hist = chess.history({ verbose: true });
  const r = new Chess();
  if (h.SetUp === '1' && h.FEN) { try { r.load(h.FEN); } catch {} }
  const toks = [];
  for (let i = 0; i < hist.length; i++) {
    const move = hist[i];
    const ply = i + 1;
    const fenBefore = r.fen();
    const isWhite = fenBefore.split(' ')[1] === 'w';
    const fullMove = +(fenBefore.split(' ')[5] ?? '1');
    if (isWhite) toks.push(`${fullMove}.`); else if (i === 0) toks.push(`${fullMove}...`);
    const ann = byPly.get(ply);
    const suf = ann && ann.nag.length ? (NAG_SYMBOL[ann.nag[0]] ?? '') : '';
    toks.push(move.san + suf);
    if (ann?.variations?.length) {
      for (const v of ann.variations) {
        const text = buildVariationText(fenBefore, v);
        if (text) toks.push(`(${text})`);
      }
    }
    try { r.move({ from: move.from, to: move.to, promotion: move.promotion }); } catch { break; }
  }
  const result = h.Result ?? '*';
  toks.push(result);
  const lines = [];
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    const s = String(v).trim(); if (!s) continue;
    lines.push(`[${k} "${s.replace(/"/g, '\\"')}"]`);
  }
  return `${lines.join('\n')}\n\n${toks.join(' ')}\n`;
}

const annotatedPgn = applyAnnotationsToPgn(pgnText, annotations);
process.stdout.write(annotatedPgn);

// Сводка по subline-длинам — для пользователя
const sublineLens = annotations
  .flatMap(a => a.variations.map(v => ({ color: v.color, len: 1 + (v.subline?.length ?? 0) })));
const greenLens = sublineLens.filter(s => s.color === 'green').map(s => s.len);
const redLens = sublineLens.filter(s => s.color === 'red').map(s => s.len);
process.stderr.write(`\n=== Summary ===\n`);
process.stderr.write(`Green variations (count=${greenLens.length}): lengths = ${JSON.stringify(greenLens)}\n`);
process.stderr.write(`Red variations   (count=${redLens.length}): lengths = ${JSON.stringify(redLens)}\n`);
process.stderr.write(`NAGs assigned: ${annotations.filter(a => a.nag.length).length} of ${annotations.length}\n`);
