-- KS-2433/KS-2435 (часть 5/5). Финал: дропаем индекс
-- `sf_validated_at_idx` (KS-2247) и сами колонки sf_*. Все зависимые
-- индексы перевыпущены / дропнуты в предыдущих миграциях
-- 20260505120000..20260505120300, поэтому ALTER TABLE проходит чисто.
--
-- Без `CREATE/DROP INDEX CONCURRENTLY` — оба DDL атомарны и проходят
-- внутри транзакции, которой Prisma migrate deploy оборачивает файл.

DROP INDEX IF EXISTS "tactic_drills_sf_validated_at_idx";

ALTER TABLE "tactic_drills"
  DROP COLUMN IF EXISTS "sf_validated_at",
  DROP COLUMN IF EXISTS "sf_rejected",
  DROP COLUMN IF EXISTS "sf_rejection_reason";
