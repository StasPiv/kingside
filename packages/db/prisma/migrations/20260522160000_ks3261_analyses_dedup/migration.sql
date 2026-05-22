-- KS-3261. Дедупликация «Моих анализов» при повторном открытии партии
-- из Архива/Трансляции + LRU-сортировка списка.
--
-- До этой задачи каждое «Открыть в мастерской» создавало новую запись
-- в `analyses`, даже если у пользователя уже есть анализ этой партии.
-- Скриншот пользователя: одна и та же партия Lu Shanglei — Bortnyk
-- дважды подряд в /studio.
--
-- Подход (см. KS-3261 design):
--   1. `source_hash TEXT NULL` — детерминированный ключ источника.
--      Вычисляется в коде по приоритету:
--        a) `lichess:<lichessGameId>` (Lichess broadcast)
--        b) `archive:<archiveGameId>` (наши archive_games)
--        c) `pgn:<sha256(lower(white)|lower(black)|date|event|round)>`
--      NULL если headers неполные — не дедуплицируем (safer).
--   2. `last_opened_at TIMESTAMPTZ DEFAULT now()` — LRU.
--      Сортировка списка `findAll` теперь по нему.
--   3. `lichess_game_id`/`archive_game_id` — отдельные nullable колонки
--      для bulk-check архив-карточек («уже в мастерской») по индексу
--      на конкретной колонке, без парсинга hash-prefix'а.
--   4. Уникальный составной индекс `(user_id, source_hash)` — Postgres
--      различает NULL'ы (NULL ≠ NULL), поэтому записи без source_hash
--      не блокируют друг друга. Только не-NULL пары уникализируются.
--
-- Backfill: для legacy-записей `last_opened_at = createdAt` (через
-- DEFAULT now() — но `now()` снимка миграции). Дублей legacy не лечим
-- в этой миграции — координатор сказал «отдельный follow-up если
-- пользователь попросит» (KS-3261 description, замечание в конце).
--
-- Все ALTER TABLE здесь — лёгкие (ADD COLUMN с DEFAULT, индексы CREATE
-- — без CONCURRENTLY, т.к. Prisma migrate оборачивает в транзакцию;
-- таблица `analyses` сейчас небольшая, ~сотни записей, не миллионы —
-- ACCESS SHARE-lock на секунды допустим).

ALTER TABLE "analyses"
  ADD COLUMN IF NOT EXISTS "source_hash" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "lichess_game_id" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "archive_game_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "last_opened_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill last_opened_at = created_at для legacy-записей: после ADD
-- COLUMN ... DEFAULT now() все записи получили now() — без этого UPDATE
-- LRU-сортировка показала бы их как «все открыты одновременно сейчас».
-- Идемпотентно: при повторном применении created_at < last_opened_at
-- останется true только для тех, кого ещё не пересчитали.
UPDATE "analyses"
   SET "last_opened_at" = "created_at"
 WHERE "last_opened_at" > "created_at";

CREATE INDEX IF NOT EXISTS "analyses_user_last_opened_idx"
  ON "analyses" ("user_id", "last_opened_at" DESC);

CREATE INDEX IF NOT EXISTS "analyses_user_lichess_game_idx"
  ON "analyses" ("user_id", "lichess_game_id");

CREATE INDEX IF NOT EXISTS "analyses_user_archive_game_idx"
  ON "analyses" ("user_id", "archive_game_id");

-- Уникальность пары (user_id, source_hash). NULL-значения source_hash
-- не блокируют друг друга — Postgres трактует NULL ≠ NULL. То есть
-- legacy-записи и анализы без source-данных создаются свободно.
CREATE UNIQUE INDEX IF NOT EXISTS "analyses_user_source_uniq"
  ON "analyses" ("user_id", "source_hash");
