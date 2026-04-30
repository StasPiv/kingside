-- KS-2160 (ADR-034 §2.1, §10.1 B0+B1).
-- Synthetic users — фундамент для пакета KS-2159: schema + индексы +
-- data-migration перевода 12 legacy-ботов в новую категорию.
--
-- Все изменения backward-compatible:
--   - новые колонки nullable / с DEFAULT (existing rows не ломаются);
--   - новые индексы — отдельные, не пересекаются с существующими.
--
-- Откат — в `rollback.sql` рядом (Prisma штатно `down` не использует;
-- для аварийного отката devops применяет SQL вручную).

BEGIN;

-- 1. users: новые поля is_synthetic / country
ALTER TABLE "users"
  ADD COLUMN "is_synthetic" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "country" CHAR(2);

-- 2. games: новые поля is_synthetic_opponent / opponent_name_synthetic
ALTER TABLE "games"
  ADD COLUMN "is_synthetic_opponent" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "opponent_name_synthetic" TEXT;

-- 3. Индексы. Только по users.is_synthetic — для scheduler'а KS-2164,
--    который делает `findMany WHERE is_synthetic=true LIMIT N`.
--    Индекс по games.is_synthetic_opponent не создаём — KS-2167
--    (исключение synthetic из публичных чартов) отменена, без её
--    SELECT'ов use-case'а у индекса не остаётся.
CREATE INDEX "users_is_synthetic_idx" ON "users" ("is_synthetic");

-- 4. Data-migration: 12 legacy-ботов из MATCHMAKING_BOTS
--    (packages/shared/src/constants.ts:47) переводятся в новую категорию.
--    После этого `isBot=false`, но `isSynthetic=true`. Текущая роль
--    30s-fallback продолжает работать через MATCHMAKING_BOTS константу
--    (она не зависит от поля is_bot напрямую) — реальное удаление
--    legacy-роли отдельным тикетом (Matchmaking refactor).
UPDATE "users"
   SET "is_bot" = FALSE,
       "is_synthetic" = TRUE
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

COMMIT;
