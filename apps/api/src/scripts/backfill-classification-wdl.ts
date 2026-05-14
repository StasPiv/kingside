/**
 * KS-3022 / ADR-066 §7.2 B3. Бэкфил `precision_attempt_moves.classification`
 * + агрегатов `precision_attempts.*` + `score`/`score_pct` после
 * переключения classifyMove на WDL-loss (KS-3020 / B1).
 *
 * Зачем:
 *   До ADR-066 классификация считалась через cp-loss. На крайних
 *   (теоретически выигранных) позициях cp может «прыгать» на сотни
 *   пунктов между ходами, при том что WDL не меняется. Старые legacy
 *   attempt'ы в БД содержат classification из старой шкалы → на UI
 *   виден конфликт «5★ + ходы с `?`». Backfill пересчитывает все
 *   per-move classifications через `classifyMove` из shared (новая
 *   WDL-логика), пересчитывает агрегаты и `score`/`score_pct` (потому
 *   что worst-class cap в `computePrecisionScore` зависит от новых
 *   классификаций).
 *
 * Алгоритм:
 *   1. Cursor-based по `attemptId ASC` (UUID lexicographic). Стартовый
 *      cursor — null-UUID `00000000-…`, чтобы Prisma приняла валидный
 *      UUID-предикат `gt`.
 *   2. Берём пачку `batchSize` attempts через `findMany` с `include {moves}`.
 *   3. Для каждого attempt (отдельная транзакция, чтобы не блокировать
 *      runtime на 100K строках сразу):
 *      a. Перебираем moves в порядке `ply ASC`.
 *      b. Для каждого move: собираем `PrecisionMoveInput`
 *         (wdlBefore/wdlAfter из 3 Int? колонок, cpBefore/cpAfter,
 *         isBestMove = playedUci === bestUci), вызываем `classifyMove`.
 *      c. UPDATE move если classification отличается.
 *      d. Считаем агрегаты: counts по каждой категории, accuracyPercent
 *         = (best+good)/total*100, firstMistakePly = min ply среди
 *         mistake/blunder.
 *      e. Вызываем `computePrecisionScore` на новой классификации
 *         (через `PrecisionMoveInput[]`) → новые `score`, `scorePct`.
 *         Это согласно ADR-066 §7.2 финальному шагу: worst-class cap
 *         в score зависит от классификации, без пересчёта получим
 *         inconsistency.
 *      f. UPDATE precision_attempt с агрегатами и score.
 *   4. Sleep 100ms между батчами.
 *
 * Идемпотентен: повторный запуск даст идентичный результат (та же
 * формула, те же входные WDL/cp).
 *
 * Запуск:
 *   DATABASE_URL=... npx ts-node apps/api/src/scripts/backfill-classification-wdl.ts
 *   # или
 *   npm run backfill:classification-wdl
 *
 * ENV:
 *   BACKFILL_DRY_RUN=1 — посчитать без записи.
 *   BACKFILL_BATCH_SIZE=N (default 100).
 *   BACKFILL_SLEEP_MS=N (default 100).
 *
 * На проде запускает devops в ночное окно (Q3 = KS-3028).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaClient } from '@kingside/db';
import {
  classifyMove,
  computePrecisionScore,
  type MoveClass,
  type PrecisionMoveClass,
  type PrecisionMoveInput,
} from '@kingside/shared';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_SLEEP_MS = 100;
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MoveRow {
  ply: number;
  playedUci: string;
  bestUci: string;
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

const CLASS_KEYS = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;
type ClassKey = (typeof CLASS_KEYS)[number];

interface Distribution {
  best: number;
  good: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

function emptyDistribution(): Distribution {
  return { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

/**
 * KS-3023: SQL-snapshot distribution для аудита.
 * `SELECT classification, COUNT(*) FROM precision_attempt_moves GROUP BY classification`.
 * Не зависит от in-memory счётчиков скрипта — авторитетный источник.
 */
async function fetchDistribution(
  prisma: PrismaClient,
): Promise<Distribution> {
  const rows = await prisma.precisionAttemptMove.groupBy({
    by: ['classification'],
    _count: { classification: true },
  });
  const dist = emptyDistribution();
  for (const r of rows) {
    const key = r.classification as ClassKey;
    if (CLASS_KEYS.includes(key)) {
      dist[key] = r._count.classification;
    }
  }
  return dist;
}

interface BackfillStats {
  attemptsScanned: number;
  attemptsChanged: number;
  movesScanned: number;
  movesReclassified: number;
  scoresChanged: number;
  before: Distribution;
  after: Distribution;
  /**
   * KS-3023 / ADR-066 §10 Риск 10: список attempt_id с изменением
   * `score` — для пост-backfill ручного аудита (если потребуется
   * откатить редкие сильные изменения star-оценки).
   */
  scoreChanges: Array<{
    attemptId: string;
    before: number | null;
    after: number | null;
  }>;
}

function buildMoveInput(m: MoveRow): {
  input: PrecisionMoveInput;
  isBestMove: boolean;
} {
  const wdlBefore =
    m.wdlBeforeW != null && m.wdlBeforeD != null && m.wdlBeforeL != null
      ? { w: m.wdlBeforeW, d: m.wdlBeforeD, l: m.wdlBeforeL }
      : null;
  const wdlAfter =
    m.wdlAfterW != null && m.wdlAfterD != null && m.wdlAfterL != null
      ? { w: m.wdlAfterW, d: m.wdlAfterD, l: m.wdlAfterL }
      : null;
  const isBestMove = m.playedUci === m.bestUci;
  return {
    input: {
      wdlBefore,
      wdlAfter,
      cpBefore: m.cpBefore,
      cpAfter: m.cpAfter,
      classification: undefined, // переопределим после classifyMove
    },
    isBestMove,
  };
}

async function main(): Promise<void> {
  const batchSize =
    parseInt(process.env.BACKFILL_BATCH_SIZE ?? '', 10) || DEFAULT_BATCH_SIZE;
  const sleepMs =
    parseInt(process.env.BACKFILL_SLEEP_MS ?? '', 10) || DEFAULT_SLEEP_MS;
  const dryRun = process.env.BACKFILL_DRY_RUN === '1';

  const prisma = new PrismaClient();
  const stats: BackfillStats = {
    attemptsScanned: 0,
    attemptsChanged: 0,
    movesScanned: 0,
    movesReclassified: 0,
    scoresChanged: 0,
    before: emptyDistribution(),
    after: emptyDistribution(),
    scoreChanges: [],
  };
  let cursor = NULL_UUID;
  let batches = 0;

  process.stdout.write(
    `[backfill-classification-wdl] start batchSize=${batchSize} ` +
      `sleepMs=${sleepMs} dryRun=${dryRun}\n`,
  );

  // KS-3023: SQL-snapshot distribution до backfill.
  const sqlBefore = await fetchDistribution(prisma);
  process.stdout.write(
    `[backfill-classification-wdl] SQL distribution BEFORE: ${JSON.stringify(sqlBefore)}\n`,
  );

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const attempts = await prisma.precisionAttempt.findMany({
        where: { attemptId: { gt: cursor } },
        select: {
          attemptId: true,
          score: true,
          moves: {
            select: {
              ply: true,
              playedUci: true,
              bestUci: true,
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
            orderBy: { ply: 'asc' },
          },
        },
        orderBy: { attemptId: 'asc' },
        take: batchSize,
      });
      if (attempts.length === 0) break;
      batches++;

      for (const attempt of attempts) {
        stats.attemptsScanned++;
        cursor = attempt.attemptId;
        if (attempt.moves.length === 0) {
          // Пустой attempt — оставляем как есть.
          continue;
        }

        const counts = emptyDistribution();
        let firstMistakePly: number | null = null;
        const moveInputs: PrecisionMoveInput[] = [];
        let attemptChanged = false;

        await prisma.$transaction(async (tx) => {
          for (const m of attempt.moves) {
            stats.movesScanned++;
            const oldClass = m.classification as MoveClass;
            stats.before[oldClass as ClassKey] += 1;

            const { input, isBestMove } = buildMoveInput(m);
            const newClass = classifyMove({ ...input, isBestMove });
            stats.after[newClass as ClassKey] += 1;

            if (newClass !== oldClass) {
              stats.movesReclassified++;
              attemptChanged = true;
              if (!dryRun) {
                await tx.precisionAttemptMove.update({
                  where: {
                    attemptId_ply: {
                      attemptId: attempt.attemptId,
                      ply: m.ply,
                    },
                  },
                  data: { classification: newClass },
                });
              }
            }

            counts[newClass as ClassKey] += 1;
            if (
              firstMistakePly == null &&
              (newClass === 'mistake' || newClass === 'blunder')
            ) {
              firstMistakePly = m.ply;
            }
            // Для computePrecisionScore сюда отдаём classification —
            // worst-class cap зависит от неё.
            moveInputs.push({
              wdlBefore: input.wdlBefore,
              wdlAfter: input.wdlAfter,
              cpBefore: input.cpBefore,
              cpAfter: input.cpAfter,
              classification: newClass as PrecisionMoveClass,
            });
          }

          const total = attempt.moves.length;
          const accuracyPercent =
            total > 0 ? ((counts.best + counts.good) / total) * 100 : 0;
          const scoreResult = computePrecisionScore(moveInputs);
          const oldScore = attempt.score;
          const scoreChanged = oldScore !== scoreResult.stars;
          if (scoreChanged) {
            stats.scoresChanged++;
            // KS-3023 / ADR-066 §10 Риск 10: фиксируем для аудита.
            stats.scoreChanges.push({
              attemptId: attempt.attemptId,
              before: oldScore,
              after: scoreResult.stars,
            });
          }

          if (!dryRun) {
            await tx.precisionAttempt.update({
              where: { attemptId: attempt.attemptId },
              data: {
                bestMovesCount: counts.best,
                goodMovesCount: counts.good,
                inaccuraciesCount: counts.inaccuracy,
                mistakesCount: counts.mistake,
                blundersCount: counts.blunder,
                accuracyPercent,
                firstMistakePly,
                score: scoreResult.stars,
                scorePct: scoreResult.scorePct,
              },
            });
          }

          if (attemptChanged || scoreChanged) stats.attemptsChanged++;
        });
      }

      process.stdout.write(
        `[backfill-classification-wdl] batch=${batches} ` +
          `attempts=${stats.attemptsScanned} ` +
          `moves=${stats.movesScanned} ` +
          `reclassified=${stats.movesReclassified} ` +
          `scoreChanged=${stats.scoresChanged}\n`,
      );

      if (attempts.length < batchSize) break;
      await sleep(sleepMs);
    }
  } finally {
    await prisma.$disconnect();
  }

  // KS-3023: SQL-snapshot distribution после backfill (авторитетный).
  const sqlAfter = await fetchDistribution(prisma);

  // Финальный отчёт + KS-3023 (B4): запись лог-файла для аудита.
  const summary =
    `[backfill-classification-wdl] DONE\n` +
    `  date: ${new Date().toISOString()}\n` +
    `  dryRun: ${dryRun}\n` +
    `  batches: ${batches}\n` +
    `  attemptsScanned: ${stats.attemptsScanned}\n` +
    `  attemptsChanged: ${stats.attemptsChanged}\n` +
    `  movesScanned: ${stats.movesScanned}\n` +
    `  movesReclassified: ${stats.movesReclassified}\n` +
    `  scoresChanged: ${stats.scoresChanged}\n` +
    `  SQL distribution BEFORE: ${JSON.stringify(sqlBefore)}\n` +
    `  SQL distribution AFTER:  ${JSON.stringify(sqlAfter)}\n` +
    `  in-memory BEFORE (processed): ${JSON.stringify(stats.before)}\n` +
    `  in-memory AFTER  (processed): ${JSON.stringify(stats.after)}\n`;
  process.stdout.write('\n' + summary);

  // KS-3023 / ADR-066 §10 Риск 10. Лог-файл с distribution до/после +
  // полным списком attempt_id с изменением score (для аудита, если
  // потребуется откатить отдельные сильные изменения star-оценки).
  // Каталог `apps/api/src/scripts/logs/` создаётся автоматически.
  const logsDir = path.resolve(__dirname, 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const logPath = path.join(
    logsDir,
    `backfill-classification-wdl-${timestamp}${dryRun ? '-dryrun' : ''}.log`,
  );
  const scoreChangesLog =
    stats.scoreChanges.length === 0
      ? '  (none)\n'
      : stats.scoreChanges
          .map(
            (c) =>
              `  ${c.attemptId}  ${c.before ?? 'null'} → ${c.after ?? 'null'}\n`,
          )
          .join('');
  const fileContent =
    `# Backfill classification (WDL) — ADR-066 B3+B4\n` +
    `# Generated: ${new Date().toISOString()}\n\n` +
    `## Summary\n` +
    summary +
    `\n## SQL distribution diff\n` +
    CLASS_KEYS.map(
      (k) => `  ${k}: ${sqlBefore[k]} → ${sqlAfter[k]} (Δ ${sqlAfter[k] - sqlBefore[k]})`,
    ).join('\n') +
    `\n\n## Score changes (KS-3023 / ADR-066 §10 Risk 10)\n` +
    `# attempt_id  oldScore → newScore\n` +
    scoreChangesLog;
  await fs.writeFile(logPath, fileContent, 'utf8');
  process.stdout.write(`[backfill-classification-wdl] log: ${logPath}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
