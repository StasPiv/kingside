/**
 * Import script for Lichess puzzle database CSV (KS-2556).
 *
 * Источник: https://database.lichess.org/lichess_db_puzzle.csv.zst
 *   ~600 МБ сжатый, ~4M записей. Колонки:
 *   PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity, NbPlays,
 *   Themes, GameUrl, OpeningTags
 *
 * Маппинг в нашу схему `Puzzle`:
 *   - id ← PuzzleId (lichess короткий код типа `00sHx`).
 *   - source ← 'lichess' (default колонки, не указываем явно).
 *   - solutionMode ← 'forced-line' (default колонки).
 *   - остальные поля по соответствию (`themes` — строка через пробел,
 *     совпадает с Lichess-форматом).
 *
 * Идемпотентность: `prisma.puzzle.createMany({ skipDuplicates: true })`
 * — повторный запуск пропускает уже существующие PuzzleId.
 *
 * Использование:
 *   1. Скачать датасет:
 *      `curl -L -o /tmp/lichess_db_puzzle.csv.zst \
 *         https://database.lichess.org/lichess_db_puzzle.csv.zst`
 *   2. Запустить импорт (один из двух режимов):
 *      a) Через системный zstd (рекомендуется):
 *         `node dist/puzzle/import-puzzles.js \
 *            /tmp/lichess_db_puzzle.csv.zst --zstd`
 *      b) Предварительная распаковка:
 *         `zstd -d /tmp/lichess_db_puzzle.csv.zst`
 *         `node dist/puzzle/import-puzzles.js /tmp/lichess_db_puzzle.csv`
 *      c) Опциональный лимит первого N строк (для теста):
 *         добавить аргумент `<limit>` в конец, например `1000`.
 *
 * ENV:
 *   - DATABASE_URL — обязательно, Prisma подключается к этой БД.
 *   - IMPORT_BATCH_SIZE (опц.) — размер batch'а для createMany.
 *     Default 5000. Увеличить → меньше round-trips, больше памяти.
 *
 * Время на 4M записей: ~10-30 мин в зависимости от latency БД и
 * inserts/sec (typical RDS db.t3.medium: ~3-5k inserts/sec через
 * createMany batch=5000).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { PrismaClient, Prisma } from '@kingside/db';
import { parseLine } from './parse-puzzle-csv';

interface ImportOptions {
  csvPath: string;
  /** true → запустить `zstd -d --stdout <csvPath>` и читать stdout. */
  useZstd: boolean;
  /** Ограничить количество строк (>0). 0 = без лимита. */
  limit: number;
}

async function importPuzzles(
  opts: ImportOptions,
  prisma: PrismaClient,
): Promise<void> {
  const { csvPath, useZstd, limit } = opts;
  if (!fs.existsSync(csvPath)) {
    throw new Error(`File not found: ${csvPath}`);
  }
  const batchSize = Math.max(
    100,
    parseInt(process.env.IMPORT_BATCH_SIZE ?? '5000', 10) || 5000,
  );

  let zstdProc: ChildProcess | null = null;
  let inputStream: NodeJS.ReadableStream;
  if (useZstd) {
    // child_process — zstd -d читает .zst и пишет в stdout.
    zstdProc = spawn('zstd', ['-d', '--stdout', csvPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (!zstdProc.stdout) throw new Error('zstd stdout missing');
    inputStream = zstdProc.stdout;
  } else {
    inputStream = fs.createReadStream(csvPath);
  }

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  let count = 0;
  let skipped = 0;
  let batch: Prisma.PuzzleCreateManyInput[] = [];
  let isFirstLine = true;
  const startedAt = Date.now();
  const PROGRESS_EVERY_BATCHES = 10; // ≈ каждые 50k строк при batch=5000

  let batchesDone = 0;
  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false;
      if (line.startsWith('PuzzleId')) continue;
    }
    if (limit > 0 && count + batch.length >= limit) break;

    const record = parseLine(line);
    if (!record) {
      skipped++;
      continue;
    }
    batch.push(record);

    if (batch.length >= batchSize) {
      await prisma.puzzle.createMany({
        data: batch,
        skipDuplicates: true,
      });
      count += batch.length;
      batch = [];
      batchesDone++;
      if (batchesDone % PROGRESS_EVERY_BATCHES === 0) {
        const seconds = (Date.now() - startedAt) / 1000;
        const rate = Math.round(count / Math.max(1, seconds));
        console.log(
          `Imported ${count} puzzles (${rate} rows/sec, skipped=${skipped})`,
        );
      }
    }
  }
  if (batch.length > 0) {
    await prisma.puzzle.createMany({
      data: batch,
      skipDuplicates: true,
    });
    count += batch.length;
  }

  if (zstdProc) {
    // Дождёмся, пока zstd закроется (на случай early-break).
    await new Promise<void>((resolve) => {
      if (zstdProc!.exitCode !== null) return resolve();
      zstdProc!.once('close', () => resolve());
    });
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Done. Total imported: ${count}, skipped: ${skipped}, time: ${totalSec}s.`,
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const csvPath = args[0];
  const useZstd =
    args.includes('--zstd') || (csvPath?.endsWith('.zst') ?? false);
  // limit — последний числовой аргумент, если есть (не флаг).
  const numericArg = args.find(
    (a, i) => i > 0 && a !== '--zstd' && /^\d+$/.test(a),
  );
  const limit = numericArg ? parseInt(numericArg, 10) : 0;

  if (!csvPath) {
    console.error(
      'Usage: node dist/puzzle/import-puzzles.js <csv-path> [--zstd] [limit]',
    );
    process.exit(1);
  }

  // KS-2556: PrismaClient создаётся только когда скрипт запущен
  // напрямую (CLI). Это позволяет файлу попадать в dist без побочных
  // эффектов при случайном импорте другим модулем.
  const prisma = new PrismaClient();
  importPuzzles({ csvPath, useZstd, limit }, prisma)
    .catch((e) => {
      console.error('Import failed:', e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
