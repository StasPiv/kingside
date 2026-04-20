/**
 * CLI cleanup-positions — удаляет строки из `archive_game_positions`,
 * принадлежащие не-классическим партиям (ADR-015 §3.4).
 *
 * Стратегия:
 *   - Батчевый `DELETE ... WHERE ctid IN (SELECT ctid FROM ... JOIN ...
 *     WHERE is_classical = false LIMIT N)` — не блокирует таблицу целиком,
 *     каждая итерация держит short-lived lock.
 *   - Цикл, пока `$executeRawUnsafe` возвращает > 0 удалённых строк.
 *   - Идемпотентно: при повторном запуске первый же SELECT не найдёт
 *     кандидатов → 0 DELETE'ов.
 *
 * Запуск:
 *   DATABASE_URL=... npm run archive:cleanup-positions \
 *     --workspace=apps/archive-importer
 */

import { PrismaClient } from '@kingside/db';

const BATCH_SIZE = 10_000;
const PROGRESS_TAG = '[cleanup-positions]';

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function countToDelete(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS cnt
       FROM archive_game_positions p
       JOIN archive_games g ON g.id = p.game_id
       WHERE g.is_classical = false`,
  );
  const v = rows[0]?.cnt ?? 0;
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

export async function cleanupPositions(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    const totalInTable = await prisma.archiveGamePosition.count().catch(() => 0);
    const totalToDelete = await countToDelete(prisma);
    console.log(
      `${PROGRESS_TAG} archive_game_positions total=${totalInTable}; ` +
        `to_delete=${totalToDelete}; batch=${BATCH_SIZE}`,
    );

    if (totalToDelete === 0) {
      console.log(`${PROGRESS_TAG} nothing to delete — already clean`);
      return;
    }

    const startedAt = Date.now();
    let deleted = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const affected = await prisma.$executeRawUnsafe(
        `DELETE FROM archive_game_positions
           WHERE ctid IN (
             SELECT p.ctid
               FROM archive_game_positions p
               JOIN archive_games g ON g.id = p.game_id
              WHERE g.is_classical = false
              LIMIT $1
           )`,
        BATCH_SIZE,
      );
      if (affected === 0) break;
      deleted += affected;

      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = elapsed > 0 ? deleted / elapsed : 0;
      const remaining = Math.max(0, totalToDelete - deleted);
      const eta = rate > 0 ? remaining / rate : Infinity;
      const pct = totalToDelete > 0 ? ((deleted / totalToDelete) * 100).toFixed(1) : '—';
      console.log(
        `${PROGRESS_TAG} deleted=${deleted}/${totalToDelete} (${pct}%) ` +
          `rate=${rate.toFixed(0)} rows/s ETA=${formatEta(eta)}`,
      );
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    const stillToDelete = await countToDelete(prisma);
    console.log(
      `${PROGRESS_TAG} DONE deleted=${deleted} elapsed=${formatEta(elapsed)} ` +
        `remaining_to_delete=${stillToDelete}`,
    );
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

// ESM-safe CLI entry.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] &&
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (isDirectRun) {
  cleanupPositions().catch((err) => {
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
