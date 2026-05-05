-- KS-2433/KS-2435 (часть 1/5). Создаём замену для KS-2355 индекса
-- `(type, sf_rejected, id)` — после удаления sf_rejected keyset-random
-- `/tactic-drill/next` будет использовать `(type, id)`.
--
-- Prisma 6.19 оборачивает каждый файл миграции в транзакцию, а
-- `CREATE INDEX CONCURRENTLY` несовместим с транзакцией (PG 25001).
-- Поэтому весь шаг выпуска индексов разбит на отдельные миграции —
-- по одному CONCURRENTLY-statement на файл (как в 20260504100000 /
-- 20260504130000, которые применились без проблем).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_type_id_idx"
  ON "tactic_drills" ("type", "id");
