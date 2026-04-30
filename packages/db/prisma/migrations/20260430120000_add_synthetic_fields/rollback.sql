-- KS-2160 rollback. Применяется devops'ом ВРУЧНУЮ если нужно откатить
-- миграцию `20260430120000_add_synthetic_fields`. Prisma штатно `down`
-- не запускает (см. `prisma migrate reset` для полного сброса dev-БД).
--
-- Перед откатом убедиться, что код, ожидающий новые поля (KS-2161+),
-- НЕ задеплоен. Иначе runtime-ошибки на чтении колонок.

BEGIN;

-- 1. Откат data-migration: возвращаем legacy-боты в `isBot=true`,
--    `isSynthetic=false`. Это идемпотентно — если кто-то уже вручную
--    сбросил флаги, UPDATE просто не изменит строки.
UPDATE "users"
   SET "is_bot" = TRUE,
       "is_synthetic" = FALSE
 WHERE "id"::text IN (
   '00000000-0000-4000-b000-000000000001',
   '00000000-0000-4000-b000-000000000002',
   '00000000-0000-4000-b000-000000000003',
   '00000000-0000-4000-b000-000000000004',
   '00000000-0000-4000-b000-000000000005',
   '00000000-0000-4000-b000-000000000006',
   '00000000-0000-4000-b000-000000000007',
   '00000000-0000-4000-b000-000000000008',
   '00000000-0000-4000-b000-000000000009',
   '00000000-0000-4000-b000-00000000000a',
   '00000000-0000-4000-b000-00000000000b',
   '00000000-0000-4000-b000-00000000000c'
 );

-- 2. Удалить индексы (порядок: индексы → колонки). Индекс
--    games_is_synthetic_opponent_idx не создавался (см. migration.sql),
--    поэтому здесь только users_is_synthetic_idx.
DROP INDEX IF EXISTS "users_is_synthetic_idx";

-- 3. Удалить новые колонки. CASCADE не используем — никаких FK на эти
--    поля не строится.
ALTER TABLE "games"
  DROP COLUMN IF EXISTS "opponent_name_synthetic",
  DROP COLUMN IF EXISTS "is_synthetic_opponent";

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "country",
  DROP COLUMN IF EXISTS "is_synthetic";

COMMIT;
