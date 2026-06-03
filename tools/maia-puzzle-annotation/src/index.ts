/**
 * KS-3641 / ADR-106 §2.1 (Precision-Maia v2, T1).
 *
 * Admin-CLI разовой Maia-разметки Precision-пазлов по новому алгоритму
 * `maiaWeakChoiceProb` (сумма policy Maia по «слабым» ходам — loss_E
 * > 0.02 относительно лучшего из {firstMovePV1} ∪ MaiaTopK).
 *
 * Заменяет старую top-1 реализацию (ADR-104, отменено). После прогона
 * каждый `puzzle WHERE solution_mode='play-vs-engine'` получает тройку:
 *   - `maia_weak_choice_prob` (REAL, 0..1)
 *   - `maia_metric_version` (INT, текущая версия алгоритма из
 *     `@kingside/maia-core` → `MAIA_WEAK_CHOICE_METRIC_VERSION`)
 *   - `maia_top1_elo` (INT, ELO разметки — audit-поле)
 *
 * Запуск (из корня репо локально либо из `/app/tools/maia-puzzle-
 * annotation/` в проде):
 *
 *   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
 *     node --import tsx tools/maia-puzzle-annotation/src/index.ts \
 *       --elo=1500 \
 *       --batch-size=1000 \
 *       --force \
 *       [--solution-mode=play-vs-engine] \
 *       [--model-path=/app/tools/maia3/maia3_simplified.onnx] \
 *       [--sf-depth=15]
 *
 * `--force` ОБЯЗАТЕЛЕН для основного прогона (annotate). Сразу после
 * миграции KS-3639 поле `maia_weak_choice_prob` содержит «грязные»
 * значения от старой top-1 формулы — `--resume` сам по себе их не
 * увидит как валидные (там же maia_metric_version IS NULL), но для
 * страховки требуем явный `--force` — чтобы не запускать аннотацию
 * случайно. `--report` и `--dry-run` работают без `--force`.
 *
 * Алгоритм:
 *   1. Maia.predictMoves(fen, elo, elo) → policy.
 *   2. buildMaiaSearchMoves(policy, firstMovePV1) → searchMoves
 *      (Maia top-K по porогу policy > 0.10, max K=8, плюс
 *      firstMovePV1 из sourceMetadata).
 *   3. SF `go depth N searchmoves m1 m2 …` → MultiPV-линии с WDL.
 *   4. expectedScores из wdl через `expectedScoreFromWdl` (+
 *      `wdlOrMateFallback` для mate-без-WDL).
 *   5. computeWeakChoiceProb({policy, firstMovePV1, expectedScores})
 *      → результат.
 *   6. UPDATE puzzle с тройкой полей.
 *
 * Идемпотентность:
 *   - `--resume` (default): пропустить строки, уже размеченные под
 *     текущим (`elo`, `metric_version`) — WHERE учитывает
 *     `maia_weak_choice_prob IS NULL OR maia_top1_elo != $elo OR
 *      maia_metric_version IS NULL OR maia_metric_version != $version`.
 *   - `--force`: игнорирует фильтр resume, перепрогоняет всё.
 *
 * Отчёт по гистограмме (`--report`) считает только строки с
 * актуальной `maia_metric_version` — старые «грязные» не путают
 * статистику.
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@kingside/db';
import {
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  Maia,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
  createNodeProvider,
  loadModelFromFs,
} from '@kingside/maia-core';
import {
  expectedScoreFromWdl,
  wdlOrMateFallback,
} from '@kingside/shared';

import { resolvePveSolutionUci } from './solution-uci.js';
import { StockfishSession } from './stockfish.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_PATH = path.resolve(
  HERE,
  '../../maia3/maia3_simplified.onnx',
);

interface CliOpts {
  elo: number;
  batchSize: number;
  resume: boolean;
  force: boolean;
  solutionMode: string;
  modelPath: string;
  sfDepth: number;
  report: boolean;
  dryRun: boolean;
}

const VALUE_FLAGS = new Set<string>([
  'elo',
  'batch-size',
  'solution-mode',
  'model-path',
  'sf-depth',
]);

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
    sfDepth: parseInt(process.env.PRECISION_MAIA_SF_DEPTH ?? '15', 10),
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
          process.stderr.write(`[maia-annotate] --elo: число, получено '${value}'\n`);
          process.exit(2);
        }
        opts.elo = n;
        break;
      }
      case 'batch-size': {
        const n = parseInt(value as string, 10);
        if (!Number.isFinite(n) || n < 1) {
          process.stderr.write(`[maia-annotate] --batch-size: положительное число, получено '${value}'\n`);
          process.exit(2);
        }
        opts.batchSize = n;
        break;
      }
      case 'sf-depth': {
        const n = parseInt(value as string, 10);
        if (!Number.isFinite(n) || n < 1 || n > 30) {
          process.stderr.write(`[maia-annotate] --sf-depth: 1..30, получено '${value}'\n`);
          process.exit(2);
        }
        opts.sfDepth = n;
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
    `tools/maia-puzzle-annotation — KS-3641 / ADR-106 §2.1 (v2 weak-choice prob)\n\n` +
      `Usage: node --import tsx tools/maia-puzzle-annotation/src/index.ts [flags]\n` +
      `       (формат --key=value и --key value оба поддержаны)\n\n` +
      `Flags:\n` +
      `  --elo N           ELO разметки (default ENV PRECISION_MAIA_ANNOTATION_ELO / 1500)\n` +
      `  --batch-size N    Размер пакета чтения из БД (default 1000)\n` +
      `  --sf-depth N      Stockfish depth для оценки кандидатов (1..30, default 15)\n` +
      `  --resume          Пропускать строки уже размеченные под текущим (elo, metric_version) (default)\n` +
      `  --no-resume       Не пропускать (но не перезаписывать non-NULL под другим elo/version)\n` +
      `  --force           Перезаписать всё (ОБЯЗАТЕЛЕН для основного прогона)\n` +
      `  --solution-mode M Фильтр (default play-vs-engine)\n` +
      `  --model-path P    Путь к ONNX (default ${DEFAULT_MODEL_PATH})\n` +
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
      | { maiaWeakChoiceProb: null }
      | { maiaTop1Elo: { not: number } }
      | { maiaMetricVersion: null }
      | { maiaMetricVersion: { not: number } }
    >;
  };
  const where: Where = { solutionMode: opts.solutionMode };
  if (cursorId) where.id = { gt: cursorId };
  if (opts.resume && !opts.force) {
    // KS-3641: строка считается «уже размечена под текущим запуском»
    // если есть значение + elo совпадает + metric_version совпадает.
    // Любое отклонение → попадает в выборку (re-annotate).
    where.OR = [
      { maiaWeakChoiceProb: null },
      { maiaTop1Elo: { not: opts.elo } },
      { maiaMetricVersion: null },
      { maiaMetricVersion: { not: MAIA_WEAK_CHOICE_METRIC_VERSION } },
    ];
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
  weakChoiceProb: number | null;
  errorReason?: string;
  errorMessage?: string;
}

async function annotateRow(
  maia: Maia,
  sf: StockfishSession,
  row: { id: string; fen: string; moves: string; sourceMetadata: string | null },
  opts: CliOpts,
): Promise<RowResult> {
  const firstMovePV1 = resolvePveSolutionUci(row.moves, row.sourceMetadata);
  if (!firstMovePV1) {
    return {
      id: row.id,
      weakChoiceProb: null,
      errorReason: 'no-solution-uci',
      errorMessage: 'firstMovePV1 отсутствует в sourceMetadata и moves[0] пустой',
    };
  }

  let maiaResult;
  try {
    maiaResult = await maia.predictMoves(row.fen, opts.elo, opts.elo);
  } catch (e) {
    return {
      id: row.id,
      weakChoiceProb: null,
      errorReason: 'maia-exception',
      errorMessage: (e as Error).message,
    };
  }
  if (maiaResult.policy.length === 0) {
    return {
      id: row.id,
      weakChoiceProb: null,
      errorReason: 'maia-empty-policy',
      errorMessage: 'Maia не вернула ни одного легального хода',
    };
  }

  const { searchMoves } = buildMaiaSearchMoves(maiaResult.policy, firstMovePV1);
  if (searchMoves.length === 0) {
    // policy слабая (все < 0.10) и firstMovePV1 пустой — крайне редкий
    // кейс. Пишем 0 (нечего считать слабым).
    return { id: row.id, weakChoiceProb: 0 };
  }

  let sfLines;
  try {
    sfLines = await sf.analyzeWithSearchMoves(row.fen, opts.sfDepth, searchMoves);
  } catch (e) {
    return {
      id: row.id,
      weakChoiceProb: null,
      errorReason: 'sf-exception',
      errorMessage: (e as Error).message,
    };
  }

  const expectedScores = new Map<string, number>();
  for (const line of sfLines) {
    const wdl = wdlOrMateFallback(line.wdl, line.score);
    if (!wdl) continue;
    expectedScores.set(line.bestMove, expectedScoreFromWdl(wdl));
  }

  const result = computeWeakChoiceProb({
    policy: maiaResult.policy,
    firstMovePV1,
    expectedScores,
  });

  return { id: row.id, weakChoiceProb: result.weakChoiceProb };
}

interface ErrorAggregator {
  samplePrinted: number;
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
    if (r.errorReason || r.weakChoiceProb === null) {
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
        data: {
          maiaWeakChoiceProb: r.weakChoiceProb,
          maiaMetricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
          maiaTop1Elo: elo,
        },
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
 * Гистограмма + % отсева для порогов ADR-106 §2.6.
 *
 * Семантика инвертирована относительно отменённой ADR-104: пазл
 * проходит фильтр, если `weakChoiceProb >= threshold` (вероятность
 * сыграть плохо). Отчёт показывает «сколько пройдёт» для каждого
 * порога (а не «сколько отсеется» — терминология ADR изменилась).
 *
 * Считаются только строки с актуальной `maia_metric_version` —
 * старые «грязные» значения от ADR-104 не должны путать статистику.
 */
async function runReport(prisma: PrismaClient, opts: CliOpts): Promise<void> {
  const rows = await prisma.puzzle.findMany({
    where: {
      solutionMode: opts.solutionMode,
      maiaWeakChoiceProb: { not: null },
      maiaMetricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
    },
    select: { maiaWeakChoiceProb: true },
  });
  if (rows.length === 0) {
    process.stdout.write(
      `[report] нет строк с актуальной metric_version=${MAIA_WEAK_CHOICE_METRIC_VERSION} ` +
        `(solution_mode=${opts.solutionMode}). Прогон CLI не делался либо был под старой формулой.\n`,
    );
    return;
  }
  const total = rows.length;
  const buckets = new Array<number>(10).fill(0);
  let pass30 = 0;
  let pass50 = 0;
  let pass70 = 0;
  for (const r of rows) {
    const p = r.maiaWeakChoiceProb as number;
    const b = Math.min(9, Math.floor(p * 10));
    buckets[b]++;
    if (p >= 0.3) pass30++;
    if (p >= 0.5) pass50++;
    if (p >= 0.7) pass70++;
  }
  const avg = rows.reduce((a, r) => a + (r.maiaWeakChoiceProb as number), 0) / total;

  process.stdout.write(`\n=== Maia weak-choice annotation report (KS-3641 / ADR-106) ===\n`);
  process.stdout.write(
    `Total annotated (metric_version=${MAIA_WEAK_CHOICE_METRIC_VERSION}): ${total}\n`,
  );
  process.stdout.write(`Avg weakChoiceProb: ${avg.toFixed(4)}\n`);
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
    `\nПропустит фильтр (prob >= threshold = пазл считается «сложным» по Maia):\n` +
      `  N=0.30: ${pass30}/${total} (${((pass30 / total) * 100).toFixed(2)}%)\n` +
      `  N=0.50: ${pass50}/${total} (${((pass50 / total) * 100).toFixed(2)}%)\n` +
      `  N=0.70: ${pass70}/${total} (${((pass70 / total) * 100).toFixed(2)}%)\n` +
      `=== end ===\n`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // KS-3641: --force обязателен для основного прогона. --report и
  // --dry-run работают без него.
  if (!opts.report && !opts.dryRun && !opts.force) {
    process.stderr.write(
      `[maia-annotate] ОШИБКА: --force обязателен для annotate-прогона.\n` +
        `  После миграции KS-3639 (ADR-106 §2.5) старые значения maia_top1_prob\n` +
        `  физически переименованы в maia_weak_choice_prob, но семантически\n` +
        `  непригодны под новой формулой (ADR-106 §5). Прогон с --force\n` +
        `  гарантирует полную перезапись.\n` +
        `  Для отчёта по уже размеченным используй --report (без --force).\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `[maia-annotate] start elo=${opts.elo} batch=${opts.batchSize} ` +
      `mode=${opts.solutionMode} resume=${opts.resume} force=${opts.force} ` +
      `dryRun=${opts.dryRun} sfDepth=${opts.sfDepth} ` +
      `metricVersion=${MAIA_WEAK_CHOICE_METRIC_VERSION} model=${opts.modelPath}\n`,
  );

  const prisma = new PrismaClient();
  const sf = new StockfishSession();
  try {
    if (opts.report) {
      await runReport(prisma, opts);
      return;
    }

    process.stdout.write(`[maia-annotate] loading model + spawning stockfish...\n`);
    const t0 = performance.now();
    const maia = new Maia({
      provider: createNodeProvider(),
      fetchBuffer: () => loadModelFromFs(opts.modelPath),
    });
    await Promise.all([maia.ensureSession(), sf.init()]);
    process.stdout.write(
      `[maia-annotate] ready in ${(performance.now() - t0).toFixed(0)}ms\n`,
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
        const r = await annotateRow(maia, sf, row, opts);
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
          ).toFixed(2)} puzzles/sec)\n`,
      );
    }

    const totalSec = (performance.now() - start) / 1000;
    process.stdout.write(
      `\n[maia-annotate] done. processed=${totalProcessed} updated=${totalUpdated} ` +
        `errors=${totalErrors} time=${totalSec.toFixed(1)}s ` +
        `rate=${(totalProcessed / Math.max(totalSec, 0.001)).toFixed(2)} puzzles/sec\n`,
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
    sf.close();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`[maia-annotate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
