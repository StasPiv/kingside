/**
 * KS-3001 / ADR-065 §6.3 B5. Бэкфил `precision_attempts.score` и
 * `score_pct` для legacy-attempt'ов, созданных до KS-2999 (т.е. до
 * раскатки server-side `computePrecisionScore`).
 *
 * Алгоритм:
 *   1. Cursor-based пагинация по `precision_attempts.attemptId ASC` среди
 *      записей с `score IS NULL`. Cursor обязателен — если ставить
 *      score=NULL (legacy без WDL/cp вообще), `WHERE score IS NULL`
 *      продолжит выбирать ту же запись на следующей итерации.
 *      Поэтому продвигаемся по `attemptId > lastSeen`.
 *   2. Для каждой записи: load `precision_attempt_moves` (WDL колонки
 *      в виде трёх Int? полей + cpBefore/cpAfter + classification).
 *   3. `computePrecisionScore` (KS-2997) → `{stars, scorePct}`.
 *   4. UPDATE `precision_attempts` для конкретного `attemptId`. Если
 *      `stars=null` (нет ни WDL, ни cp, либо <2 ходов, либо >50% gaps),
 *      записываем NULL — фронт показывает binary fallback (ADR §6.2).
 *   5. Sleep 100ms между батчами — не нагружаем БД ночью.
 *
 * Идемпотентен: повторный запуск пропустит уже обработанные записи
 * по `score IS NOT NULL`. Запись с реальным NULL после прохода будет
 * пропущена через cursor (мы прошли её attemptId).
 *
 * Запуск:
 *   DATABASE_URL=... npx ts-node apps/api/src/scripts/backfill-precision-score.ts
 *   # или через npm-script:
 *   npm run backfill:precision-score
 *
 * Опционально:
 *   BACKFILL_DRY_RUN=1 — только посчитать, не писать в БД.
 *   BACKFILL_BATCH_SIZE=N — переопределить размер батча (default 100).
 *   BACKFILL_SLEEP_MS=N — переопределить sleep между батчами (default 100).
 *
 * Запускает devops на проде в ночное окно (Q3 из ADR-065 §7 Этап 4).
 */
import { PrismaClient } from '@kingside/db';
import {
  computePrecisionScore,
  type PrecisionMoveClass,
  type PrecisionMoveInput,
} from '@kingside/shared';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_SLEEP_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MoveRow {
  cpBefore: number | null;
  cpAfter: number | null;
  wdlBeforeW: number | null;
  wdlBeforeD: number | null;
  wdlBeforeL: number | null;
  wdlAfterW: number | null;
  wdlAfterD: number | null;
  wdlAfterL: number | null;
  classification: string;
}

/**
 * Сборка `PrecisionMoveInput[]` из per-move строк precision_attempt_moves.
 * Все три WDL-компонента должны быть заданы, иначе wdlBefore/After=null
 * (тогда вычислитель идёт по cp-ветке или classification-fallback).
 */
function buildMoveInputs(moves: MoveRow[]): PrecisionMoveInput[] {
  return moves.map((m) => ({
    wdlBefore:
      m.wdlBeforeW != null && m.wdlBeforeD != null && m.wdlBeforeL != null
        ? { w: m.wdlBeforeW, d: m.wdlBeforeD, l: m.wdlBeforeL }
        : null,
    wdlAfter:
      m.wdlAfterW != null && m.wdlAfterD != null && m.wdlAfterL != null
        ? { w: m.wdlAfterW, d: m.wdlAfterD, l: m.wdlAfterL }
        : null,
    cpBefore: m.cpBefore,
    cpAfter: m.cpAfter,
    classification: m.classification as PrecisionMoveClass,
  }));
}

interface BackfillStats {
  scanned: number;
  updatedWithScore: number;
  updatedNull: number; // прошли через computePrecisionScore, но stars=null
  batches: number;
}

async function main(): Promise<void> {
  const batchSize =
    parseInt(process.env.BACKFILL_BATCH_SIZE ?? '', 10) || DEFAULT_BATCH_SIZE;
  const sleepMs =
    parseInt(process.env.BACKFILL_SLEEP_MS ?? '', 10) || DEFAULT_SLEEP_MS;
  const dryRun = process.env.BACKFILL_DRY_RUN === '1';

  const prisma = new PrismaClient();
  const stats: BackfillStats = {
    scanned: 0,
    updatedWithScore: 0,
    updatedNull: 0,
    batches: 0,
  };
  // Cursor — последний обработанный attemptId. attemptId — Postgres UUID,
  // Prisma требует валидный UUID-формат даже для предиката `gt`. На старте
  // используем `null-UUID` — любой реальный v4 UUID лексикографически > него.
  let cursor = '00000000-0000-0000-0000-000000000000';

  process.stdout.write(
    `[backfill-precision-score] start batchSize=${batchSize} sleepMs=${sleepMs} dryRun=${dryRun}\n`,
  );

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await prisma.precisionAttempt.findMany({
        where: {
          score: null,
          attemptId: { gt: cursor },
        },
        select: {
          attemptId: true,
          moves: {
            select: {
              cpBefore: true,
              cpAfter: true,
              wdlBeforeW: true,
              wdlBeforeD: true,
              wdlBeforeL: true,
              wdlAfterW: true,
              wdlAfterD: true,
              wdlAfterL: true,
              classification: true,
            },
            // Порядок per-move не критичен для агрегата (mean/min
            // симметричны), но классификация worst-class — тоже
            // симметрична, так что order не влияет на результат.
          },
        },
        orderBy: { attemptId: 'asc' },
        take: batchSize,
      });
      if (rows.length === 0) break;

      stats.batches++;
      for (const row of rows) {
        stats.scanned++;
        const moves = buildMoveInputs(row.moves);
        const result = computePrecisionScore(moves);

        if (!dryRun) {
          await prisma.precisionAttempt.update({
            where: { attemptId: row.attemptId },
            data: {
              score: result.stars,
              scorePct: result.scorePct,
            },
          });
        }

        if (result.stars !== null) stats.updatedWithScore++;
        else stats.updatedNull++;

        cursor = row.attemptId;
      }

      process.stdout.write(
        `[backfill-precision-score] batch=${stats.batches} ` +
          `scanned=${stats.scanned} ` +
          `withScore=${stats.updatedWithScore} ` +
          `stillNull=${stats.updatedNull}\n`,
      );

      if (rows.length < batchSize) break;
      await sleep(sleepMs);
    }
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write(
    `[backfill-precision-score] DONE batches=${stats.batches} ` +
      `scanned=${stats.scanned} ` +
      `withScore=${stats.updatedWithScore} ` +
      `stillNull=${stats.updatedNull}` +
      (dryRun ? ' (dry-run, БД не изменена)' : '') +
      `\n`,
  );
  if (stats.updatedNull > 0) {
    process.stdout.write(
      `[backfill-precision-score] NOTE: ${stats.updatedNull} attempts ` +
        `остались score=NULL — нет per-move WDL/cp (legacy до KS-2754) ` +
        `или halfMovesPlayed<2. Эти записи будут перепроверяться при ` +
        `повторных запусках (UPDATE с NULL — идемпотентен по данным).` +
        `\n`,
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
