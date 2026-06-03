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
 *       [--model-path apps/web/public/maia3/maia3_simplified.onnx]
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
 *      (детерминированный порядок).
 *   3. Для каждой строки: `predictMoves(fen, elo, elo)`, поиск
 *      вероятности `puzzle.moves[0]` (с учётом mirror) — записывается
 *      в `maia_top1_prob`.
 *   4. Batch UPDATE через `prisma.puzzle.update` (по одному, без
 *      транзакции — независимые строки).
 *   5. Лог `[annotation] processed=K skipped=S errors=E elapsed=Tms`.
 *
 * Отчёт по гистограмме и %% отсева для порогов 0.3/0.5/0.7 — отдельный
 * sub-команд `--report` (без записи) либо post-prod SQL-агрегация
 * (см. README).
 */
import { performance } from 'node:perf_hooks';

import { PrismaClient } from '@kingside/db';
import {
  Maia,
  createNodeProvider,
  loadModelFromFs,
  mirrorMove,
} from '@kingside/maia-core';

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

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    elo: parseInt(process.env.PRECISION_MAIA_ANNOTATION_ELO ?? '1500', 10),
    batchSize: 1000,
    resume: true,
    force: false,
    solutionMode: 'play-vs-engine',
    modelPath:
      process.env.PRECISION_MAIA_MODEL_PATH ??
      'apps/web/public/maia3/maia3_simplified.onnx',
    report: false,
    dryRun: false,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = valueRaw ?? '';
    switch (key) {
      case 'elo':
        opts.elo = parseInt(value, 10);
        break;
      case 'batch-size':
        opts.batchSize = Math.max(1, parseInt(value, 10));
        break;
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
        opts.solutionMode = value;
        break;
      case 'model-path':
        opts.modelPath = value;
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
      default:
        process.stderr.write(`[maia-annotate] unknown flag: --${key}\n`);
    }
  }
  if (!Number.isFinite(opts.elo)) opts.elo = 1500;
  if (!Number.isFinite(opts.batchSize)) opts.batchSize = 1000;
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    `tools/maia-puzzle-annotation — KS-3632 / ADR-104 §4\n\n` +
      `Usage: node --import tsx tools/maia-puzzle-annotation/src/index.ts [flags]\n\n` +
      `Flags:\n` +
      `  --elo N           ELO разметки (default ENV PRECISION_MAIA_ANNOTATION_ELO / 1500)\n` +
      `  --batch-size N    Размер пакета чтения (default 1000)\n` +
      `  --resume          Пропускать уже размеченные под текущим ELO (default)\n` +
      `  --no-resume       Не пропускать (но и не перезаписывать non-NULL под другим ELO)\n` +
      `  --force           Перезаписать всё (включая non-NULL под другим ELO)\n` +
      `  --solution-mode M Фильтр (default play-vs-engine)\n` +
      `  --model-path P    Путь к ONNX (default apps/web/public/maia3/maia3_simplified.onnx)\n` +
      `  --report          Сделать отчёт по гистограмме (без записи)\n` +
      `  --dry-run         Не писать в БД (только лог)\n`,
  );
}

async function fetchBatch(
  prisma: PrismaClient,
  opts: CliOpts,
  cursorId: string | null,
): Promise<Array<{ id: string; fen: string; moves: string }>> {
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
    select: { id: true, fen: true, moves: true },
    orderBy: { id: 'asc' },
    take: opts.batchSize,
  });
}

interface RowResult {
  id: string;
  prob: number | null;
  error?: string;
}

async function annotateRow(
  maia: Maia,
  row: { id: string; fen: string; moves: string },
  elo: number,
): Promise<RowResult> {
  const solutionUci = row.moves.split(' ')[0]?.trim();
  if (!solutionUci) return { id: row.id, prob: null, error: 'empty-moves' };
  try {
    const result = await maia.predictMoves(row.fen, elo, elo);
    const direct =
      result.policy.find((p) => p.move === solutionUci)?.probability ?? 0;
    const mirrored =
      result.policy.find((p) => p.move === mirrorMove(solutionUci))
        ?.probability ?? 0;
    return { id: row.id, prob: Math.max(direct, mirrored) };
  } catch (e) {
    return { id: row.id, prob: null, error: (e as Error).message };
  }
}

async function writeBatchUpdate(
  prisma: PrismaClient,
  results: RowResult[],
  elo: number,
  dryRun: boolean,
): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  for (const r of results) {
    if (r.error || r.prob === null) {
      errors++;
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
      process.stderr.write(
        `[maia-annotate] update failed for ${r.id}: ${(e as Error).message}\n`,
      );
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
            (totalProcessed / ((performance.now() - start) / 1000)) /
            1
          ).toFixed(1)} puzzles/sec)\n`,
      );
    }

    const totalSec = (performance.now() - start) / 1000;
    process.stdout.write(
      `\n[maia-annotate] done. processed=${totalProcessed} updated=${totalUpdated} ` +
        `errors=${totalErrors} time=${totalSec.toFixed(1)}s ` +
        `rate=${(totalProcessed / Math.max(totalSec, 0.001)).toFixed(1)} puzzles/sec\n`,
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`[maia-annotate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
