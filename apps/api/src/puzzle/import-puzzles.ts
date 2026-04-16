/**
 * Import script for Lichess puzzle database CSV.
 *
 * Usage:
 *   1. Download the Lichess puzzle database CSV from:
 *      https://database.lichess.org/lichess_db_puzzle.csv.zst
 *   2. Decompress: zstd -d lichess_db_puzzle.csv.zst
 *   3. Run: npx ts-node src/puzzle/import-puzzles.ts <path-to-csv> [limit]
 *
 * CSV format:
 *   PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import { parseLine } from './parse-puzzle-csv';

const prisma = new PrismaClient();

async function importPuzzles(csvPath: string, limit: number) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`File not found: ${csvPath}`);
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let count = 0;
  let skipped = 0;
  let batch: Prisma.PuzzleCreateManyInput[] = [];
  const BATCH_SIZE = 1000;
  let isFirstLine = true;

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

    if (batch.length >= BATCH_SIZE) {
      await prisma.puzzle.createMany({
        data: batch,
        skipDuplicates: true,
      });
      count += batch.length;
      console.log(`Imported ${count} puzzles...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await prisma.puzzle.createMany({
      data: batch,
      skipDuplicates: true,
    });
    count += batch.length;
  }

  console.log(`Done. Total imported: ${count}, skipped: ${skipped}.`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const csvPath = args[0];
  const limit = parseInt(args[1] || '0', 10);

  if (!csvPath) {
    console.error('Usage: npx ts-node src/puzzle/import-puzzles.ts <csv-path> [limit]');
    process.exit(1);
  }

  importPuzzles(csvPath, limit)
    .catch((e) => {
      console.error('Import failed:', e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
