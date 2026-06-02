/**
 * KS-3564 / ADR-094 §3.4, §3.6, §7. Backfill phase-тегов для
 * исторических generated-puzzle'ов.
 *
 * Алгоритм:
 *   1. SELECT id, fen, themes FROM puzzles
 *      WHERE source = 'generated'
 *        AND themes !~* '(^| )(opening|middlegame|endgame)( |$)'
 *      LIMIT 500.
 *   2. Для каждой строки — `phase = detectPhase(fen)` (импорт из
 *      `puzzle-generator/tagging.ts`).
 *   3. UPDATE puzzles SET themes = trim(themes || ' ' || $phase)
 *      WHERE id = $id. Каждая пачка — Prisma $transaction.
 *   4. Лог прогресса каждые 500.
 *
 * Идемпотентно: WHERE-фильтр исключает уже размеченные. Повторный
 * запуск — no-op (lichess не трогается; уже размеченные generated
 * пропускаются).
 *
 * НЕ trogaet `source='lichess'` — у lichess свои оригинальные phase-теги
 * от lichess-puzzler.
 *
 * Запуск:
 *   DATABASE_URL=... \
 *     npx ts-node apps/tactic-worker/scripts/backfill-phase.ts \
 *     [--batch=500] [--dry-run] [--limit=N]
 *
 * Перед прод-запуском — pg_dump таблицы puzzles
 * (см. ADR-094 §7, инструкция в KS-3564).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { detectPhase } from '../src/puzzle-generator/tagging';

interface CliFlags {
  batch: number;
  dryRun: boolean;
  limit: number;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    batch: 500,
    dryRun: false,
    limit: Infinity,
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    switch (k) {
      case 'batch':
        flags.batch = parseInt(v, 10);
        break;
      case 'dry-run':
        flags.dryRun = true;
        break;
      case 'limit':
        flags.limit = parseInt(v, 10);
        break;
    }
  }
  return flags;
}

/**
 * KS-3564 regex (matches KS-3563 audit query). `(^| )` / `( |$)` —
 * слово целиком, чтобы избежать ложных совпадений (например тема
 * `preopening` не должна засчитываться как `opening`).
 */
const PHASE_REGEX = '(^| )(opening|middlegame|endgame)( |$)';

interface PuzzleRow {
  id: string;
  fen: string;
  themes: string;
}

async function run(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `[backfill-phase] start flags=${JSON.stringify(flags)} regex='${PHASE_REGEX}'`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const prisma = app.get(PrismaService);

  let totalProcessed = 0;
  let totalSkipped = 0;
  const phaseCounts: Record<string, number> = {
    opening: 0,
    middlegame: 0,
    endgame: 0,
  };

  const t0 = Date.now();
  try {
    for (;;) {
      // Размер последней пачки уменьшаем под --limit.
      const remaining = flags.limit - totalProcessed;
      if (remaining <= 0) {
        console.log('[backfill-phase] --limit reached, stop');
        break;
      }
      const take = Math.min(flags.batch, remaining);

      const batch = await prisma.$queryRawUnsafe<PuzzleRow[]>(
        `SELECT id, fen, themes
           FROM puzzles
          WHERE source = 'generated'
            AND themes !~* $1
          LIMIT ${take}`,
        PHASE_REGEX,
      );

      if (batch.length === 0) {
        console.log('[backfill-phase] no more rows, exit');
        break;
      }

      if (flags.dryRun) {
        // dry-run: считаем фазы, не пишем в БД.
        for (const row of batch) {
          try {
            const phase = detectPhase(row.fen);
            phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
            totalProcessed++;
          } catch (err) {
            console.warn(
              `[backfill-phase] detectPhase failed for id=${row.id}: ` +
                `${(err as Error).message}`,
            );
            totalSkipped++;
          }
        }
      } else {
        await prisma.$transaction(async (tx) => {
          for (const row of batch) {
            let phase: 'opening' | 'middlegame' | 'endgame';
            try {
              phase = detectPhase(row.fen);
            } catch (err) {
              console.warn(
                `[backfill-phase] detectPhase failed for id=${row.id}: ` +
                  `${(err as Error).message}`,
              );
              totalSkipped++;
              continue;
            }
            const existing = row.themes ?? '';
            const newThemes = existing.trim()
              ? `${existing.trim()} ${phase}`
              : phase;
            await tx.$executeRawUnsafe(
              `UPDATE puzzles SET themes = $1 WHERE id = $2`,
              newThemes,
              row.id,
            );
            phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
            totalProcessed++;
          }
        });
      }

      const dt = Math.round((Date.now() - t0) / 1000);
      console.log(
        `[backfill-phase] batch=${batch.length} ` +
          `processed=${totalProcessed} skipped=${totalSkipped} ` +
          `phases=${JSON.stringify(phaseCounts)} ${dt}s`,
      );

      // Если последняя пачка короче запрошенного — дальше пусто.
      if (batch.length < take) {
        console.log('[backfill-phase] partial batch — done');
        break;
      }
    }
  } finally {
    await app.close();
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[backfill-phase] DONE processed=${totalProcessed} skipped=${totalSkipped} ` +
      `phases=${JSON.stringify(phaseCounts)} ${dt}s dryRun=${flags.dryRun}`,
  );
}

run().catch((err) => {
  console.error('[backfill-phase] FATAL:', err);
  process.exit(1);
});
