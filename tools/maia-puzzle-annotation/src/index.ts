/**
 * KS-3632 / ADR-104 §4 (MVP-2 Precision-Maia, T1).
 *
 * Admin-CLI для разовой Maia-3 разметки существующих Precision-пазлов.
 * После прогона каждый `puzzle WHERE solution_mode='play-vs-engine'`
 * получает `maia_top1_prob` (вероятность правильного хода) и
 * `maia_top1_elo` (ELO, под которым прогнали — для воспроизводимости).
 *
 * Запуск (из корня репо):
 *
 *   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
 *     node --import tsx tools/maia-puzzle-annotation/src/index.ts \
 *       --elo 1500 \
 *       --batch-size 1000 \
 *       --resume \
 *       [--solution-mode play-vs-engine] \
 *       [--force] \
 *       [--model-path /app/tools/maia3/maia3_simplified.onnx]
 *
 * Допускаются оба формата `--key=value` и `--key value`. Неизвестные
 * флаги и positional-аргументы валят CLI с ненулевым exit-кодом —
 * раньше `--elo 1500` (с пробелом) молча игнорировалось, дефолт 1500
 * подменял переданное значение (KS-3635).
 *
 * Идемпотентность:
 *   - `--resume` (default): пропускает строки с `maia_top1_prob IS NOT
 *     NULL AND maia_top1_elo = $ELO`. Безопасно для прерывания.
 *   - `--force`: перепрогоняет всё (для смены ELO глобально или замены
 *     модели).
 *
 * Алгоритм:
 *   1. Загрузка Maia-3 ONNX через `@kingside/maia-core` (Node-провайдер
 *      на onnxruntime-web/WASM). Сессия лениво поднимается при первом
 *      inference.
 *   2. Чтение `Puzzle` батчами по `--batch-size` `ORDER BY id`
 *      (детерминированный порядок). Селектится также `sourceMetadata`
 *      — оттуда берётся правильный ход (`firstMovePV1`), у play-vs-
 *      engine `moves` пустая строка (см. `solution-uci.ts`).
 *   3. Для каждой строки: `predictMoves(fen, elo, elo)`, поиск
 *      вероятности правильного хода (с учётом mirror).
 *   4. Batch UPDATE через `prisma.puzzle.update` (по одному, без
 *      транзакции — независимые строки).
 *   5. Лог `[annotation] processed=K updated=U errors=E elapsed=Tms`.
 *   6. По завершении — сводка по типам ошибок (`errorsByReason`)
 *      и первые до 20 строк с (id, reason, message) в stderr на
 *      время прогона.
 *
 * Отчёт по гистограмме и %% отсева для порогов 0.3/0.5/0.7 — отдельный
 * sub-команд `--report` (без записи) либо post-prod SQL-агрегация
 * (см. README).
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@kingside/db';
import {
  Maia,
  createNodeProvider,
  loadModelFromFs,
  mirrorMove,
} from '@kingside/maia-core';

import { resolvePveSolutionUci } from './solution-uci.js';

// __dirname-эквивалент для ESM. CLI запускается через `node --import
// tsx`, у tsx ESM-режим по умолчанию. До фикса дефолтный modelPath
// был относительный к CWD ('tools/maia3/...'), что ломалось в
// контейнере (CWD ≠ /app, см. KS-3635).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_PATH = path.resolve(HERE, '../../maia3/maia3_simplified.onnx');

interface CliOpts {
  elo: number;
  batchSize: number;
  resume: boolean;
  force: boolean;
  solutionMode: string;
  modelPath: string;
  report: boolean;
  dryRun: boolean;
}

// Флаги, которым нужно value (--key value или --key=value).
const VALUE_FLAGS = new Set<string>([
  'elo',
  'batch-size',
  'solution-mode',
  'model-path',
]);

// Boolean-флаги (без value).
const BOOL_FLAGS = new Set<string>([
  'resume',
  'no-resume',
  'force',
  'report',
  'dry-run',
  'help',
  'h',
]);

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    elo: parseInt(process.env.PRECISION_MAIA_ANNOTATION_ELO ?? '1500', 10),
    batchSize: 1000,
    resume: true,
    force: false,
    solutionMode: 'play-vs-engine',
    modelPath: process.env.PRECISION_MAIA_MODEL_PATH ?? DEFAULT_MODEL_PATH,
    report: false,
    dryRun: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      process.stderr.write(
        `[maia-annotate] positional argument не поддерживается: ${arg}\n`,
      );
      printUsage();
      process.exit(2);
    }
    const eqIdx = arg.indexOf('=');
    const key = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
    let value: string | null = null;
    if (eqIdx >= 0) {
      value = arg.slice(eqIdx + 1);
    } else if (VALUE_FLAGS.has(key)) {
      // --key value: следующий arg — значение, если это не флаг.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        process.stderr.write(
          `[maia-annotate] флагу --${key} требуется значение\n`,
        );
        printUsage();
        process.exit(2);
      }
      value = next;
      i += 1;
    }

    if (!VALUE_FLAGS.has(key) && !BOOL_FLAGS.has(key)) {
      process.stderr.write(`[maia-annotate] неизвестный флаг: --${key}\n`);
      printUsage();
      process.exit(2);
    }

    switch (key) {
      case 'elo': {
        const n = parseInt(value as string, 10);
        if (!Number.isFinite(n)) {
          process.stderr.write(`[maia-annotate] --elo: ожидалось число, получено '${value}'\n`);
          process.exit(2);
        }
        opts.elo = n;
        break;
      }
      case 'batch-size': {
        const n = parseInt(value as string, 10);
        if (!Number.isFinite(n) || n < 1) {
          process.stderr.write(`[maia-annotate] --batch-size: ожидалось положительное число, получено '${value}'\n`);
          process.exit(2);
        }
        opts.batchSize = n;
        break;
      }
      case 'resume':
        opts.resume = true;
        break;
      case 'no-resume':
        opts.resume = false;
        break;
      case 'force':
        opts.force = true;
        opts.resume = false;
        break;
      case 'solution-mode':
        opts.solutionMode = value as string;
        break;
      case 'model-path':
        opts.modelPath = value as string;
        break;
      case 'report':
        opts.report = true;
        break;
      case 'dry-run':
        opts.dryRun = true;
        break;
      case 'help':
      case 'h':
        printUsage();
        process.exit(0);
    }

    i += 1;
  }
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    `tools/maia-puzzle-annotation — KS-3632 / ADR-104 §4\n\n` +
      `Usage: node --import tsx tools/maia-puzzle-annotation/src/index.ts [flags]\n` +
      `       (формат --key=value и --key value оба поддержаны)\n\n` +
      `Flags:\n` +
      `  --elo N           ELO разметки (default ENV PRECISION_MAIA_ANNOTATION_ELO / 1500)\n` +
      `  --batch-size N    Размер пакета чтения (default 1000)\n` +
      `  --resume          Пропускать уже размеченные под текущим ELO (default)\n` +
      `  --no-resume       Не пропускать (но и не перезаписывать non-NULL под другим ELO)\n` +
      `  --force           Перезаписать всё (включая non-NULL под другим ELO)\n` +
      `  --solution-mode M Фильтр (default play-vs-engine)\n` +
      `  --model-path P    Путь к ONNX (default — резолвится от файла CLI: ${DEFAULT_MODEL_PATH})\n` +
      `  --report          Сделать отчёт по гистограмме (без записи)\n` +
      `  --dry-run         Не писать в БД (только лог)\n`,
  );
}

async function fetchBatch(
  prisma: PrismaClient,
  opts: CliOpts,
  cursorId: string | null,
): Promise<
  Array<{ id: string; fen: string; moves: string; sourceMetadata: string | null }>
> {
  type Where = {
    solutionMode: string;
    id?: { gt: string };
    OR?: Array<
      | { maiaTop1Prob: null }
      | { maiaTop1Elo: { not: number } }
    >;
  };
  const where: Where = { solutionMode: opts.solutionMode };
  if (cursorId) where.id = { gt: cursorId };
  if (opts.resume && !opts.force) {
    // resume → пропустить строки уже размеченные под текущим ELO.
    where.OR = [{ maiaTop1Prob: null }, { maiaTop1Elo: { not: opts.elo } }];
  }
  return prisma.puzzle.findMany({
    where,
    select: { id: true, fen: true, moves: true, sourceMetadata: true },
    orderBy: { id: 'asc' },
    take: opts.batchSize,
  });
}

interface RowResult {
  id: string;
  prob: number | null;
  /** Категория ошибки (для сводки по типам). */
  errorReason?: string;
  /** Детальное сообщение (первые N — печатается в stderr). */
  errorMessage?: string;
}

async function annotateRow(
  maia: Maia,
  row: { id: string; fen: string; moves: string; sourceMetadata: string | null },
  elo: number,
): Promise<RowResult> {
  const solutionUci = resolvePveSolutionUci(row.moves, row.sourceMetadata);
  if (!solutionUci) {
    return {
      id: row.id,
      prob: null,
      errorReason: 'no-solution-uci',
      errorMessage: 'firstMovePV1 отсутствует в sourceMetadata и moves[0] пустой',
    };
  }
  try {
    const result = await maia.predictMoves(row.fen, elo, elo);
    const direct =
      result.policy.find((p) => p.move === solutionUci)?.probability ?? 0;
    const mirrored =
      result.policy.find((p) => p.move === mirrorMove(solutionUci))
        ?.probability ?? 0;
    return { id: row.id, prob: Math.max(direct, mirrored) };
  } catch (e) {
    return {
      id: row.id,
      prob: null,
      errorReason: 'inference-exception',
      errorMessage: (e as Error).message,
    };
  }
}

interface ErrorAggregator {
  /** Сколько ошибок уже выведено в stderr (cap = ERROR_SAMPLE_CAP). */
  samplePrinted: number;
  /** Сколько ошибок каждого типа суммарно. */
  byReason: Map<string, number>;
}

const ERROR_SAMPLE_CAP = 20;

function recordError(
  agg: ErrorAggregator,
  id: string,
  reason: string,
  message: string,
): void {
  agg.byReason.set(reason, (agg.byReason.get(reason) ?? 0) + 1);
  if (agg.samplePrinted < ERROR_SAMPLE_CAP) {
    process.stderr.write(
      `[maia-annotate] error sample ${agg.samplePrinted + 1}/${ERROR_SAMPLE_CAP} ` +
        `puzzle=${id} reason=${reason} msg=${message}\n`,
    );
    agg.samplePrinted += 1;
  }
}

async function writeBatchUpdate(
  prisma: PrismaClient,
  results: RowResult[],
  elo: number,
  dryRun: boolean,
  agg: ErrorAggregator,
): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  for (const r of results) {
    if (r.errorReason || r.prob === null) {
      errors++;
      recordError(
        agg,
        r.id,
        r.errorReason ?? 'unknown',
        r.errorMessage ?? 'unknown',
      );
      continue;
    }
    if (dryRun) {
      updated++;
      continue;
    }
    try {
      await prisma.puzzle.update({
        where: { id: r.id },
        data: { maiaTop1Prob: r.prob, maiaTop1Elo: elo },
      });
      updated++;
    } catch (e) {
      errors++;
      recordError(agg, r.id, 'update-failed', (e as Error).message);
    }
  }
  return { updated, errors };
}

/**
 * Гистограмма + % отсева для порогов из ADR (§4.5 report).
 */
async function runReport(prisma: PrismaClient, opts: CliOpts): Promise<void> {
  const rows = await prisma.puzzle.findMany({
    where: {
      solutionMode: opts.solutionMode,
      maiaTop1Prob: { not: null },
    },
    select: { maiaTop1Prob: true },
  });
  if (rows.length === 0) {
    process.stdout.write(
      `[report] нет размеченных строк (solution_mode=${opts.solutionMode}).\n`,
    );
    return;
  }
  const total = rows.length;
  const buckets = new Array<number>(10).fill(0);
  let cutoff30 = 0;
  let cutoff50 = 0;
  let cutoff70 = 0;
  for (const r of rows) {
    const p = r.maiaTop1Prob as number;
    const b = Math.min(9, Math.floor(p * 10));
    buckets[b]++;
    if (p > 0.3) cutoff30++;
    if (p > 0.5) cutoff50++;
    if (p > 0.7) cutoff70++;
  }
  const avg = rows.reduce((a, r) => a + (r.maiaTop1Prob as number), 0) / total;

  process.stdout.write(`\n=== Maia annotation report ===\n`);
  process.stdout.write(`Total annotated: ${total}\n`);
  process.stdout.write(`Avg prob: ${avg.toFixed(4)}\n`);
  process.stdout.write(`Histogram (0..1, 10 buckets):\n`);
  for (let i = 0; i < 10; i++) {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    const pct = ((buckets[i] / total) * 100).toFixed(2);
    process.stdout.write(
      `  [${lo}..${hi}): ${buckets[i].toString().padStart(7)} (${pct}%)\n`,
    );
  }
  process.stdout.write(
    `\nCut-off (prob > threshold = пазл отсеется):\n` +
      `  N=0.30: ${cutoff30}/${total} (${((cutoff30 / total) * 100).toFixed(2)}%)\n` +
      `  N=0.50: ${cutoff50}/${total} (${((cutoff50 / total) * 100).toFixed(2)}%)\n` +
      `  N=0.70: ${cutoff70}/${total} (${((cutoff70 / total) * 100).toFixed(2)}%)\n` +
      `=== end ===\n`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `[maia-annotate] start elo=${opts.elo} batch=${opts.batchSize} ` +
      `mode=${opts.solutionMode} resume=${opts.resume} force=${opts.force} ` +
      `dryRun=${opts.dryRun} model=${opts.modelPath}\n`,
  );

  const prisma = new PrismaClient();
  try {
    if (opts.report) {
      await runReport(prisma, opts);
      return;
    }

    process.stdout.write(`[maia-annotate] loading model...\n`);
    const t0 = performance.now();
    const maia = new Maia({
      provider: createNodeProvider(),
      fetchBuffer: () => loadModelFromFs(opts.modelPath),
    });
    await maia.ensureSession();
    process.stdout.write(
      `[maia-annotate] model loaded in ${(performance.now() - t0).toFixed(0)}ms\n`,
    );

    let cursor: string | null = null;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    const errorAgg: ErrorAggregator = {
      samplePrinted: 0,
      byReason: new Map(),
    };
    const start = performance.now();

    for (;;) {
      const batch = await fetchBatch(prisma, opts, cursor);
      if (batch.length === 0) break;

      const batchStart = performance.now();
      const results: RowResult[] = [];
      for (const row of batch) {
        const r = await annotateRow(maia, row, opts.elo);
        results.push(r);
      }
      const { updated, errors } = await writeBatchUpdate(
        prisma,
        results,
        opts.elo,
        opts.dryRun,
        errorAgg,
      );
      totalProcessed += batch.length;
      totalUpdated += updated;
      totalErrors += errors;
      cursor = batch[batch.length - 1].id;
      const batchMs = performance.now() - batchStart;
      process.stdout.write(
        `[maia-annotate] batch=${batch.length} updated=${updated} ` +
          `errors=${errors} elapsed=${batchMs.toFixed(0)}ms ` +
          `total=${totalProcessed} (${(
            totalProcessed /
            Math.max((performance.now() - start) / 1000, 0.001)
          ).toFixed(1)} puzzles/sec)\n`,
      );
    }

    const totalSec = (performance.now() - start) / 1000;
    process.stdout.write(
      `\n[maia-annotate] done. processed=${totalProcessed} updated=${totalUpdated} ` +
        `errors=${totalErrors} time=${totalSec.toFixed(1)}s ` +
        `rate=${(totalProcessed / Math.max(totalSec, 0.001)).toFixed(1)} puzzles/sec\n`,
    );
    if (errorAgg.byReason.size > 0) {
      process.stdout.write(`[maia-annotate] errors by reason:\n`);
      const sorted = Array.from(errorAgg.byReason.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [reason, count] of sorted) {
        const pct = ((count / Math.max(totalProcessed, 1)) * 100).toFixed(2);
        process.stdout.write(`  ${reason}: ${count} (${pct}%)\n`);
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`[maia-annotate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
