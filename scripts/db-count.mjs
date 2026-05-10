#!/usr/bin/env node
// KS-2698: показать счётчики partией в archive_games через pg.
// `prisma db execute` SELECT не возвращает (только применяет DDL/DML),
// поэтому используем pg напрямую.
//
// Usage: node scripts/db-count.mjs
//   ENV: ARCHIVE_DATABASE_URL — строка подключения.

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.ARCHIVE_DATABASE_URL;
if (!url) {
  console.error('ARCHIVE_DATABASE_URL не задан');
  process.exit(2);
}

const sqlFile = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'sql/count-archive-games.sql',
);
const sql = fs.readFileSync(sqlFile, 'utf8');

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const res = await client.query(sql);
  for (const row of res.rows) {
    console.log('archive_games counts:');
    console.log(`  total                = ${row.total}`);
    console.log(`  classical_total      = ${row.classical_total}`);
    console.log(`  strong_any (Elo>=2400 both) = ${row.strong_any}`);
    console.log(`  strong_classical (target)   = ${row.strong_classical}`);
  }
} catch (err) {
  console.error('SQL error:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
