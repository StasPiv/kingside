#!/usr/bin/env node
/**
 * KS-3617. CLI-обёртка над системным Stockfish (`/usr/games/stockfish`).
 * Для одной FEN-позиции на запрошенной глубине отдаёт:
 *   - top-N (multipv) bestMove с PV и WDL;
 *   - signed = (W − L) / 1000 POV side-to-move;
 *   - длину PV в полуходах.
 *
 * Использование:
 *   node tools/ks3617-run-sf.mjs --fen "<FEN>" [--depth 18] [--multipv 3]
 *
 * Выход: JSON в stdout с полями { fen, depth, lines: [{ multipv, bestMove,
 *   pv, pvLen, wdl, signed }] }.
 */
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = { depth: 18, multipv: 3, fen: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fen') out.fen = argv[++i];
    else if (a === '--depth') out.depth = Number(argv[++i]);
    else if (a === '--multipv') out.multipv = Number(argv[++i]);
  }
  if (!out.fen) {
    process.stderr.write('usage: ks3617-run-sf.mjs --fen <FEN> [--depth N] [--multipv N]\n');
    process.exit(2);
  }
  return out;
}

function runSf({ fen, depth, multipv }) {
  return new Promise((resolve, reject) => {
    const sf = spawn('/usr/games/stockfish', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = new Map(); // multipv → {pv, wdl, score}
    let buf = '';

    sf.stdout.setEncoding('utf8');
    sf.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('info ') && line.includes(' pv ')) {
          const mpv = Number((line.match(/\bmultipv (\d+)/) || [])[1] || 1);
          const pv = (line.match(/\bpv (.+)/) || [])[1]?.split(' ') ?? [];
          const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
          const wdl = wdlM ? { w: +wdlM[1], d: +wdlM[2], l: +wdlM[3] } : null;
          const cpM = line.match(/\bscore cp (-?\d+)/);
          const mateM = line.match(/\bscore mate (-?\d+)/);
          const score = mateM ? { type: 'mate', value: +mateM[1] }
                      : cpM   ? { type: 'cp',   value: +cpM[1]   } : null;
          lines.set(mpv, { pv, wdl, score });
        }
        if (line.startsWith('bestmove')) {
          sf.stdin.write('quit\n');
        }
      }
    });

    sf.on('close', () => {
      const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]);
      const out = sorted.map(([mpv, v]) => ({
        multipv: mpv,
        bestMove: v.pv[0] ?? null,
        pv: v.pv,
        pvLen: v.pv.length,
        wdl: v.wdl,
        signed: v.wdl ? (v.wdl.w - v.wdl.l) / 1000 : null,
        score: v.score,
      }));
      resolve(out);
    });
    sf.on('error', reject);

    sf.stdin.write('uci\n');
    sf.stdin.write('setoption name UCI_ShowWDL value true\n');
    sf.stdin.write(`setoption name MultiPV value ${multipv}\n`);
    sf.stdin.write('isready\n');
    sf.stdin.write(`position fen ${fen}\n`);
    sf.stdin.write(`go depth ${depth}\n`);
  });
}

const args = parseArgs(process.argv);
const lines = await runSf(args);
process.stdout.write(
  JSON.stringify({ fen: args.fen, depth: args.depth, lines }, null, 2) + '\n',
);
