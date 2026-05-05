/**
 * KS-2443. Локальный CLI для валидации puzzle-generator pipeline на
 * lichess-эталонах. Не предназначен для ECS RunTask — это инструмент
 * для дебага blunder-detection.
 *
 * Контракт:
 *   ARCHIVE_DATABASE_URL не нужен.
 *   DATABASE_URL не нужен (insert не делаем).
 *   STOCKFISH_PATH=/usr/games/stockfish (default).
 *
 * Аргументы:
 *   --etalons-file=<path>   default /tmp/ks-2443-etalons.json
 *   --depth=N               default 10
 *   --multi-pv=N            default 3
 *   --output=<path>         default /tmp/ks-2443-results-d{depth}.json
 *
 * Для каждого эталона:
 *   1. Проигрывает PGN до setupPly-1 (позиция перед setup-move).
 *   2. analyze(beforeFen, depth) — bestBefore.
 *   3. Применяет setup-move (то, что в PGN был на ply setupPly).
 *   4. analyze(afterFen, depth) — actualAfter.
 *   5. evalDrop = bestCp(POV setup-side) - actualCp(POV того же).
 *   6. analyzeMultiPV(afterFen, depth, multiPV) — для spread.
 *
 * Сравнивает наш evalDrop с lichessExpectedDropCp. Считает hit-rate
 * (drop ≥ 200cp у нас vs у lichess).
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Chess } from 'chess.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { StockfishService } from '../stockfish/stockfish.service';
import { cpFromSide, isMateScore } from '../puzzle-generator/score';

interface Etalon {
  id: string;
  rating: number;
  themes: string;
  gameUrl: string;
  gameId: string;
  setupPly: number;
  setupUci: string;
  setupUciFromPuzzleMoves: string;
  fenAtUrl: string; // = fenBeforeSetup (что сохранено в Puzzle.fen)
  fenBeforeSetup: string;
  fenAfterSetup: string;
  sideMovedAtSetup: 'w' | 'b';
  lichessEvalBeforeCpWhite: number | null;
  lichessEvalAfterCpWhite: number | null;
  lichessExpectedDropCp: number | null;
}

interface Result {
  id: string;
  setupUci: string;
  ourEvalBeforeCpSide: number | null;
  ourEvalAfterCpSide: number | null;
  ourDropCp: number | null;
  ourMpvSpreadCp: number | null;
  ourBestMoveBefore: string | null;
  lichessExpectedDropCp: number | null;
  verdict:
    | 'detected-blunder'
    | 'missed-blunder'
    | 'no-eval'
    | 'engine-error';
  notes: string;
}

function parseArgs(argv: string[]): {
  etalonsFile: string;
  depth: number;
  multiPV: number;
  output: string;
} {
  const opts = {
    etalonsFile: '/tmp/ks-2443-etalons.json',
    depth: 10,
    multiPV: 3,
    output: '',
  };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'etalons-file':
        opts.etalonsFile = v;
        break;
      case 'depth':
        opts.depth = parseInt(v, 10);
        break;
      case 'multi-pv':
        opts.multiPV = parseInt(v, 10);
        break;
      case 'output':
        opts.output = v;
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  if (!opts.output) opts.output = `/tmp/ks-2443-results-d${opts.depth}.json`;
  return opts;
}

export async function runValidateEtalons(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:validate-etalons');
  const opts = parseArgs(argv);
  const engine = app.get(StockfishService);
  const etalons: Etalon[] = JSON.parse(readFileSync(opts.etalonsFile, 'utf8'));
  process.stdout.write(
    `[validate] etalons=${etalons.length} depth=${opts.depth} multiPV=${opts.multiPV}\n`,
  );

  const results: Result[] = [];
  let detected = 0;
  let missed = 0;
  let errors = 0;

  for (let i = 0; i < etalons.length; i++) {
    const e = etalons[i];
    const sideMoved = e.sideMovedAtSetup;
    const note: string[] = [];
    let result: Result = {
      id: e.id,
      setupUci: e.setupUci,
      ourEvalBeforeCpSide: null,
      ourEvalAfterCpSide: null,
      ourDropCp: null,
      ourMpvSpreadCp: null,
      ourBestMoveBefore: null,
      lichessExpectedDropCp: e.lichessExpectedDropCp,
      verdict: 'engine-error',
      notes: '',
    };
    try {
      const before = await engine.analyze(e.fenBeforeSetup, opts.depth);
      const after = await engine.analyze(e.fenAfterSetup, opts.depth);
      if (!before.score || !after.score) {
        result.verdict = 'no-eval';
        note.push('SF returned no score');
      } else {
        // beforeFen — позиция перед setup-move, на ходу sideMoved.
        // afterFen — позиция после setup-move, на ходу противник.
        const opponent = sideMoved === 'w' ? 'b' : 'w';
        const ourBestCp = cpFromSide(before.score, sideMoved, sideMoved);
        const ourActualCp = cpFromSide(after.score, sideMoved, opponent);
        const drop = ourBestCp - ourActualCp;
        result.ourEvalBeforeCpSide = ourBestCp;
        result.ourEvalAfterCpSide = ourActualCp;
        result.ourDropCp = drop;
        result.ourBestMoveBefore = before.bestMove;
        // Detected? evalDrop ≥ 200 (наш порог).
        if (drop >= 200) {
          result.verdict = 'detected-blunder';
          detected++;
        } else {
          result.verdict = 'missed-blunder';
          missed++;
        }
      }
      // MultiPV для spread на позиции после setup-move (она же стартовая
      // позиция puzzle для решающей стороны).
      const mpv = await engine.analyzeMultiPV(
        e.fenAfterSetup,
        opts.depth,
        opts.multiPV,
      );
      if (mpv.length >= 1) {
        const solverSide = sideMoved === 'w' ? 'b' : 'w';
        const bestCp = cpFromSide(mpv[0].score, solverSide, solverSide);
        const secondCp =
          mpv.length >= 2
            ? cpFromSide(mpv[1].score, solverSide, solverSide)
            : -Infinity;
        const spread = isMateScore(mpv[0].score) ? 99_999 : bestCp - secondCp;
        result.ourMpvSpreadCp = spread;
      }
    } catch (err) {
      result.verdict = 'engine-error';
      note.push(err instanceof Error ? err.message : String(err));
      errors++;
    }
    result.notes = note.join('; ');
    results.push(result);
    process.stdout.write(
      `[${i + 1}/${etalons.length}] ${e.id} ` +
        `lichessDrop=${e.lichessExpectedDropCp ?? 'n/a'} ` +
        `ourDrop=${result.ourDropCp ?? 'n/a'} ` +
        `verdict=${result.verdict} ` +
        `spread=${result.ourMpvSpreadCp ?? 'n/a'}\n`,
    );
  }

  // Сводка.
  const total = etalons.length;
  const noEval = results.filter((r) => r.verdict === 'no-eval').length;
  const summary = {
    depth: opts.depth,
    multiPV: opts.multiPV,
    total,
    detectedBlunders: detected,
    missedBlunders: missed,
    noEval,
    engineErrors: errors,
    detectionRate: total > 0 ? Math.round((100 * detected) / total) : 0,
    results,
  };
  writeFileSync(opts.output, JSON.stringify(summary, null, 2));
  process.stdout.write(
    `\n[validate] depth=${opts.depth}: detected=${detected}/${total} ` +
      `missed=${missed} noEval=${noEval} errors=${errors} → ${opts.output}\n`,
  );
  logger.log(`results saved to ${opts.output}`);
}
