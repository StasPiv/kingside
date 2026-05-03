/**
 * KS-2226 (dev-only). Применяет миграцию
 * 20260503130000_add_tactic_drills на dev-БД через
 * `prisma.$executeRawUnsafe`, потому что в dev-контейнере отсутствует
 * schema-engine binary для openssl-3.0.x (только 1.1.x; node_modules
 * read-only — симлинк не создать). На проде штатный
 * `prisma migrate deploy` работает без обхода.
 *
 * Идемпотентность:
 *   1. Если все три таблицы (`tactic_drills`,
 *      `tactic_drill_attempts`, `tactic_drill_sprint_scores`) уже есть —
 *      выходим раньше, не дублируя CREATE.
 *   2. Иначе — выполняем DDL из migration.sql одним батчем через
 *      `$executeRawUnsafe`. SQL содержит `BEGIN/COMMIT`, но Prisma
 *      multi-statement не поддерживает: разрезаем по `;` и шлём по
 *      одному, явный transaction `prisma.$transaction(...)` оборачивает
 *      набор запросов.
 *   3. Регистрируем миграцию в `_prisma_migrations` (если ещё нет).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PrismaClient } from '@kingside/db';

const MIGRATION_NAME = '20260503130000_add_tactic_drills';
const MIGRATION_DIR = path.resolve(
  '/project/packages/db/prisma/migrations',
  MIGRATION_NAME,
);

async function tablesExist(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('tactic_drills','tactic_drill_attempts','tactic_drill_sprint_scores')`,
  );
  return rows.length === 3;
}

function splitStatements(sql: string): string[] {
  // Удаляем `BEGIN;`/`COMMIT;` (мы оборачиваем через $transaction),
  // комментарии и пустые строки. Split по `;` с trim.
  const cleaned = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    if (await tablesExist(prisma)) {
      process.stdout.write('• tactic_drill* tables already present\n');
    } else {
      const sqlPath = path.join(MIGRATION_DIR, 'migration.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      const statements = splitStatements(sql);

      process.stdout.write(
        `→ applying migration ${MIGRATION_NAME} (${statements.length} statements)...\n`,
      );

      // Транзакция: либо все CREATE'ы пройдут, либо ни один.
      await prisma.$transaction(
        statements.map((stmt) => prisma.$executeRawUnsafe(stmt)),
      );
      process.stdout.write(`✓ migration ${MIGRATION_NAME} applied\n`);
    }

    const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1`,
      MIGRATION_NAME,
    );
    if (existing.length > 0) {
      process.stdout.write(
        `• migration ${MIGRATION_NAME} already registered in _prisma_migrations\n`,
      );
      return;
    }

    const sqlPath = path.join(MIGRATION_DIR, 'migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const id = crypto.randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
       VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
      id,
      checksum,
      MIGRATION_NAME,
    );
    process.stdout.write(
      `✓ migration ${MIGRATION_NAME} recorded in _prisma_migrations\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ apply-ks-2226 failed: ${e.stack ?? e}\n`);
  process.exit(1);
});
