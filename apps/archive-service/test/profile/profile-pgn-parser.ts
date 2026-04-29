#!/usr/bin/env tsx
/**
 * KS-2128 — точечный бенчмарк парсера PGN.
 *
 * Цель: измерить, сколько ms тратит `parseBatch` на 7000 синтетических
 * партий (объём современного TWIC weekly), и разложить время по этапам
 * `parseGame`:
 *   - chess.loadPgn (PGN-токенизация + валидация ходов);
 *   - replay (повторное проигрывание ходов на чистой доске ради FEN);
 *   - extractHeader (16 regex'ов на партию);
 *   - classify / classifyPgnTimeControl (regex'ы на TimeControl).
 *
 * Запуск:
 *   /project/node_modules/.bin/tsx \
 *     apps/archive-service/test/profile/profile-pgn-parser.ts [count]
 *
 * stdout — JSON со временами по этапам и общими цифрами.
 */

import { Chess } from 'chess.js';
import { generateTwicFixturePgn } from '../fixtures/twic-synthetic';
import {
  parseBatch,
  splitPgn,
  extractHeader,
} from '../../src/archive-import/pgn-utils';
import { classifyGame } from '../../src/archive-import/classify';
import { classifyPgnTimeControl } from '@kingside/shared';

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

interface StageStats {
  totalMs: number;
  perGameUs: number;
  count: number;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function timed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = nowMs();
  const result = fn();
  return { result, ms: nowMs() - t0 };
}

const HEADER_TAGS = [
  'White',
  'Black',
  'WhiteElo',
  'BlackElo',
  'WhiteTitle',
  'BlackTitle',
  'Event',
  'Site',
  'Round',
  'Date',
  'Result',
  'ECO',
  'Opening',
  'TimeControl',
  'FEN',
  'SetUp',
];

async function main(): Promise<void> {
  const count = parseInt(process.argv[2] ?? '7000', 10);
  process.stderr.write(`Generating ${count} synthetic games...\n`);
  const pgnText = generateTwicFixturePgn(count);
  const sizeMib = Buffer.byteLength(pgnText, 'utf-8') / (1024 * 1024);
  process.stderr.write(`Fixture size: ${sizeMib.toFixed(1)} MiB\n`);

  // Прогрев V8: один проход 100-партийной выборки.
  parseBatch(generateTwicFixturePgn(100));

  // ─── Полный parseBatch (baseline) ──────────────────────────────────
  const t0 = nowMs();
  const { games, failed } = parseBatch(pgnText);
  const totalMs = nowMs() - t0;
  process.stderr.write(
    `parseBatch: parsed=${games.length} failed=${failed} in ${fmt(totalMs)}\n`,
  );

  // ─── Разбивка по этапам — пройтись отдельно по каждой стадии ───────
  const splitStat = timed(() => splitPgn(pgnText));
  const rawGames = splitStat.result;

  // chess.loadPgn + history({verbose:true}) — основной chess.js cost.
  const loadPgnStat = timed(() => {
    let total = 0;
    for (const raw of rawGames) {
      const chess = new Chess();
      try {
        chess.loadPgn(raw, { strict: false });
        const hist = chess.history({ verbose: true }) as Array<unknown>;
        total += hist.length;
      } catch {
        // skip
      }
    }
    return total;
  });

  // chess.history -> replay (текущая реализация: второй проход на чистой доске).
  const replayStat = timed(() => {
    let total = 0;
    for (const raw of rawGames) {
      try {
        const chess = new Chess();
        chess.loadPgn(raw, { strict: false });
        const hist = chess.history({ verbose: true }) as Array<{
          from: string;
          to: string;
          promotion?: string;
        }>;
        const replay = new Chess();
        for (const mv of hist) {
          const r = replay.move({
            from: mv.from,
            to: mv.to,
            promotion: mv.promotion,
          });
          if (!r) break;
          // эмулируем уровень работы parseGame
          replay.fen();
        }
        total += hist.length;
      } catch {
        // skip
      }
    }
    return total;
  });

  // Альтернатива (KS-2128 hypothesis): использовать chess.history({verbose:true})
  // с `after` полем — без второго прохода replay.
  const verboseAfterStat = timed(() => {
    let total = 0;
    for (const raw of rawGames) {
      try {
        const chess = new Chess();
        chess.loadPgn(raw, { strict: false });
        const hist = chess.history({ verbose: true }) as Array<{
          from: string;
          to: string;
          promotion?: string;
          after: string;
        }>;
        for (const mv of hist) {
          // Имитируем то же объёмное поле, что у parseGame.moves[i].fenAfter.
          if (mv.after) total += 1;
        }
      } catch {
        // skip
      }
    }
    return total;
  });

  // 16 extractHeader на партию — сколько стоит regex-tax.
  const headersStat = timed(() => {
    let total = 0;
    for (const raw of rawGames) {
      for (const tag of HEADER_TAGS) {
        const v = extractHeader(raw, tag);
        if (v != null) total += 1;
      }
    }
    return total;
  });

  // classifyGame + classifyPgnTimeControl на каждой партии.
  const classifyStat = timed(() => {
    let total = 0;
    for (const raw of rawGames) {
      const tc = extractHeader(raw, 'TimeControl');
      const site = extractHeader(raw, 'Site');
      const event = extractHeader(raw, 'Event');
      const c = classifyGame({ timeControl: tc, site, event });
      const cat = classifyPgnTimeControl(tc);
      if (c.isClassical && cat) total += 1;
    }
    return total;
  });

  const stages: Record<string, StageStats> = {
    splitPgn: {
      totalMs: splitStat.ms,
      perGameUs: (splitStat.ms * 1000) / Math.max(1, rawGames.length),
      count: rawGames.length,
    },
    'chess.loadPgn+history': {
      totalMs: loadPgnStat.ms,
      perGameUs: (loadPgnStat.ms * 1000) / rawGames.length,
      count: rawGames.length,
    },
    'replay (current parseGame)': {
      totalMs: replayStat.ms,
      perGameUs: (replayStat.ms * 1000) / rawGames.length,
      count: rawGames.length,
    },
    'history({verbose}).after (alternative)': {
      totalMs: verboseAfterStat.ms,
      perGameUs: (verboseAfterStat.ms * 1000) / rawGames.length,
      count: rawGames.length,
    },
    'extractHeader×16': {
      totalMs: headersStat.ms,
      perGameUs: (headersStat.ms * 1000) / rawGames.length,
      count: rawGames.length,
    },
    'classify+classifyPgnTC': {
      totalMs: classifyStat.ms,
      perGameUs: (classifyStat.ms * 1000) / rawGames.length,
      count: rawGames.length,
    },
  };

  const output = {
    fixture: {
      count,
      sizeMib,
      rawGames: rawGames.length,
    },
    parseBatch: {
      totalMs,
      gamesParsed: games.length,
      failed,
      perGameUs: (totalMs * 1000) / count,
    },
    stages,
    saving: {
      replayVsVerboseAfterMs: replayStat.ms - verboseAfterStat.ms,
      replayVsVerboseAfterPct:
        ((replayStat.ms - verboseAfterStat.ms) / replayStat.ms) * 100,
    },
  };

  for (const [name, s] of Object.entries(stages)) {
    process.stderr.write(
      `${name.padEnd(38)} ${fmt(s.totalMs)} (${s.perGameUs.toFixed(1)}us/game)\n`,
    );
  }
  process.stderr.write(
    `parseBatch total: ${fmt(totalMs)} (${output.parseBatch.perGameUs.toFixed(1)}us/game)\n`,
  );

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(
    `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
