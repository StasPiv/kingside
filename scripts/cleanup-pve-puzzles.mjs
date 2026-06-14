#!/usr/bin/env node
// KS-2754: удалить все PVE-пазлы (solution_mode='play-vs-engine') на main-БД
// `kingside`. Каскадом утянет puzzle_attempts → precision_attempts →
// precision_attempt_moves (через FK ON DELETE CASCADE).
//
// Используется перед регенерацией пазлов в tactic-worker после правки схемы
// (коммит 96eb4acd: fenBeforeBlunder в sourceMetadata). Старые пазлы без
// этого поля фронт /precision не отрисует.
//
// Аналог `scripts/db-count.mjs` (через pg), потому что:
//   - `prisma migrate` для разовой операции — оверкилл;
//   - `prisma db execute` SELECT не возвращает, не покажет before/after;
//   - psql в окружении не установлен.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/cleanup-pve-puzzles.mjs

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN');

  const before = await client.query(
    "SELECT COUNT(*)::int AS n FROM puzzles WHERE solution_mode='play-vs-engine'",
  );
  const del = await client.query(
    "DELETE FROM puzzles WHERE solution_mode='play-vs-engine'",
  );
  const after = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM puzzles WHERE solution_mode='play-vs-engine')   AS pve_puzzles_left,
      (SELECT COUNT(*)::int FROM precision_attempts)                              AS precision_attempts_left,
      (SELECT COUNT(*)::int FROM precision_attempt_moves)                         AS precision_moves_left,
      (SELECT COUNT(*)::int FROM puzzle_attempts pa
         JOIN puzzles p ON p.id = pa.puzzle_id
        WHERE p.solution_mode='play-vs-engine')                                   AS pve_attempts_left
  `);

  await client.query('COMMIT');
  console.log('pve_puzzles_before:', before.rows[0].n);
  console.log('rows_deleted_from_puzzles:', del.rowCount);
  console.log('after:', after.rows[0]);
} catch (err) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('SQL error:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
