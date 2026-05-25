/**
 * KS-3325 / ADR-078. Data-migration backfill для multi-source.
 *
 * SQL миграция `20260525073000_ks3325_repertoire_sources` создаёт
 * таблицу `opening_repertoire_sources` и автоматически INSERT'ит один
 * `legacy-import` source на каждый существующий `OpeningRepertoire`
 * с его текущим `pgn`. Но JSONB-поле `OpeningRepertoire.tree` НЕ
 * пересчитывается — в нём по-прежнему edges без `sourceIds`.
 *
 * Этот скрипт пересобирает `tree` для всех репертуаров через
 * `RepertoireBuilderService.buildTreeFromSources([{sourceId, pgn}])` —
 * теперь edges получают `sourceIds: [<legacy-source-id>]`. Это нужно,
 * иначе при первой же source-операции (KS-3326: PATCH/POST/DELETE
 * sources) у нас потеряется привязка `edge → source`.
 *
 * Алгоритм:
 *   1. Cursor-пагинация по `OpeningRepertoire.id ASC` (включая
 *      soft-deleted — после restore им тоже нужен tree).
 *   2. Для каждого репертуара: load его sources (после миграции —
 *      ровно один legacy-import), build new tree, UPDATE.
 *   3. Skip репертуаров без sources (defensive — теоретически не
 *      должно быть после миграции).
 *
 * Идемпотентен: повторный запуск пересоберёт tree с теми же sourceIds
 * (одинаковый результат). Можно гонять много раз.
 *
 * Запуск:
 *   DATABASE_URL=... npx ts-node apps/api/src/scripts/backfill-ks3325-rebuild-sources.ts
 *
 * Опции:
 *   BACKFILL_DRY_RUN=1     — только посчитать, не писать в БД.
 *   BACKFILL_BATCH_SIZE=N  — default 50.
 *   BACKFILL_SLEEP_MS=N    — default 50.
 */
import { PrismaClient } from '@kingside/db';
import { RepertoireBuilderService } from '../opening-trainer/repertoire-builder.service';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_SLEEP_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dryRun = process.env.BACKFILL_DRY_RUN === '1';
  const batchSize = parseInt(
    process.env.BACKFILL_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE),
    10,
  );
  const sleepMs = parseInt(
    process.env.BACKFILL_SLEEP_MS ?? String(DEFAULT_SLEEP_MS),
    10,
  );

  const prisma = new PrismaClient();
  const builder = new RepertoireBuilderService();

  console.log(
    `[ks3325-backfill] start dryRun=${dryRun} batch=${batchSize} sleep=${sleepMs}ms`,
  );

  let cursor: string | null = null;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const repertoires = await prisma.openingRepertoire.findMany({
      where: cursor !== null ? { id: { gt: cursor } } : {},
      select: {
        id: true,
        title: true,
        sources: {
          select: { id: true, pgn: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (repertoires.length === 0) break;

    for (const rep of repertoires) {
      processed++;
      cursor = rep.id;
      if (!rep.sources || rep.sources.length === 0) {
        console.warn(
          `[ks3325-backfill] skip rep=${rep.id.slice(0, 8)} title="${rep.title}" — no sources rows`,
        );
        skipped++;
        continue;
      }
      try {
        const tree = builder.buildTreeFromSources(
          rep.sources.map((s) => ({ sourceId: s.id, pgn: s.pgn })),
        );
        if (dryRun) {
          updated++;
          continue;
        }
        await prisma.openingRepertoire.update({
          where: { id: rep.id },
          data: {
            tree: tree as unknown as object,
            nodeCount: tree.meta.nodeCount,
            edgeCount: tree.meta.edgeCount,
            maxDepth: tree.meta.maxDepth,
          },
        });
        updated++;
      } catch (err) {
        failed++;
        console.error(
          `[ks3325-backfill] FAIL rep=${rep.id.slice(0, 8)} title="${rep.title}": ${
            (err as Error).message
          }`,
        );
      }
    }

    console.log(
      `[ks3325-backfill] batch done processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`,
    );
    if (sleepMs > 0) await sleep(sleepMs);
  }

  console.log(
    `[ks3325-backfill] DONE total: processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[ks3325-backfill] fatal:', err);
  process.exit(1);
});
