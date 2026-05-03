/**
 * KS-2301: одноразовый apply миграции 20260503100000_add_user_test_account_hidden
 * на dev-БД через PrismaClient (`$executeRawUnsafe`).
 *
 * Контекст: prisma CLI не может загрузить schema-engine binary в нашем
 * dev-контейнере (есть только openssl-1.1.x вариант, prisma 6.19 ищет
 * openssl-3.0.x; node_modules/ read-only — симлинк не подкинуть).
 * Сама api-runtime использует libquery-engine, который рабочий, поэтому
 * мы можем выполнять любой SQL через `prisma.$executeRawUnsafe`.
 *
 * Скрипт идемпотентный:
 *   1. Проверяет есть ли колонки `is_test_account` / `is_hidden`.
 *      Если нет — ALTER TABLE с `IF NOT EXISTS` (безопасно при повторе).
 *   2. Регистрирует миграцию в `_prisma_migrations` (если ещё нет),
 *      чтобы `prisma migrate status` после починки CLI не считал её
 *      pending. На таблице нет unique-constraint'а на migration_name,
 *      поэтому проверяем наличие через SELECT.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PrismaClient } from '@kingside/db';

const MIGRATION_NAME = '20260503100000_add_user_test_account_hidden';
const MIGRATION_DIR = path.resolve(
  '/project/packages/db/prisma/migrations',
  MIGRATION_NAME,
);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // 1. ALTER TABLE при отсутствии колонок.
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users'
         AND column_name IN ('is_test_account','is_hidden')`,
    );
    const present = new Set(cols.map((c) => c.column_name));
    if (!(present.has('is_test_account') && present.has('is_hidden'))) {
      process.stdout.write('→ applying ALTER TABLE users ADD is_test_account, is_hidden ...\n');
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "users"
           ADD COLUMN IF NOT EXISTS "is_test_account" BOOLEAN NOT NULL DEFAULT FALSE,
           ADD COLUMN IF NOT EXISTS "is_hidden"       BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    } else {
      process.stdout.write('• columns is_test_account / is_hidden already present\n');
    }

    // 2. Регистрация в _prisma_migrations (без unique-конфликта).
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

    process.stdout.write(`✓ migration ${MIGRATION_NAME} recorded in _prisma_migrations\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ apply-ks-2255 failed: ${e.stack ?? e}\n`);
  process.exit(1);
});
