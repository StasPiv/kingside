/**
 * KS-2397. Одноразовый backfill: для каждого drill'а типа
 * `find-all-checks` в `tactic_drills` пересчитывает
 * `meta.expectedMoves` через predicate `findAllChecksMoves(fen)` и
 * пишет в БД через `jsonb_set(coalesce(meta,'{}')::jsonb,
 * '{expectedMoves}', $value)`.
 *
 * Идемпотентность: можно прогонять повторно — каждый раз
 * пересчитываем (FEN детерминирован), пишем одно и то же значение.
 *
 * Алгоритм:
 *   1. SELECT id, fen FROM tactic_drills WHERE type='find-all-checks'
 *      ORDER BY id ASC.
 *   2. Считаем `expectedMoves` через predicate, валидно — пишем
 *      jsonb_set; пусто (не должно случиться, но защита) — skip.
 *   3. Прогресс — каждые 500 записей.
 *
 * Запуск:
 *   DATABASE_URL=... npx ts-node \
 *     apps/api/src/scripts/backfill-find-all-checks-meta.ts
 *
 * Вывод:
 *   scanned=N updated=N skipped=N failed=N
 */
import { PrismaClient } from '@kingside/db';
import { findAllChecksMoves } from '../tactic-drill/predicates';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const stats = { scanned: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    const rows = await prisma.tacticDrill.findMany({
      where: { type: 'find-all-checks' },
      select: { id: true, fen: true },
      orderBy: { id: 'asc' },
    });
    console.log(`[backfill] total ${rows.length} find-all-checks drills`);

    for (const r of rows) {
      stats.scanned++;
      try {
        const moves = findAllChecksMoves(r.fen);
        if (moves.length === 0) {
          stats.skipped++;
          continue;
        }
        // Защита от записей, где `meta` — не jsonb-object (массив/скаляр):
        // `jsonb_set` падает с `cannot set path in scalar`. Если meta —
        // не объект, заменяем целиком на `{expectedMoves: ...}`. Это
        // штатно: meta для find-all-checks ранее был пустой/null,
        // полезных полей кроме expectedMoves у этого типа нет.
        await prisma.$executeRawUnsafe(
          `UPDATE tactic_drills
             SET meta = CASE
               WHEN meta IS NULL OR jsonb_typeof(meta) <> 'object'
                 THEN jsonb_build_object('expectedMoves', $1::jsonb)
               ELSE jsonb_set(meta, '{expectedMoves}', $1::jsonb, true)
             END
           WHERE id = $2::uuid`,
          JSON.stringify(moves),
          r.id,
        );
        stats.updated++;
      } catch (e) {
        stats.failed++;
        console.error(
          `[backfill] failed id=${r.id} fen=${r.fen}`,
          (e as Error).message,
        );
      }
      if (stats.scanned % 500 === 0) {
        console.log(
          `[backfill] progress scanned=${stats.scanned} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`,
        );
      }
    }
    console.log(
      `[backfill] done scanned=${stats.scanned} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
