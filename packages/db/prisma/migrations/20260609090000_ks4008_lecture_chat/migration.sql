-- KS-4008 / ADR-121 Phase 1 §7.3, §5.3. Чат лекции MVP.
--
-- Две новые таблицы (отдельные от существующей `chat_messages`, которая
-- завязана на `Game` — ADR-121 §7.5 не трогаем) и enum:
--   1. CREATE TYPE lecture_chat_message_kind AS ENUM ('user', 'system')
--      — `user` — обычное сообщение; `system` — служебное (закрепления,
--      mute-all, Phase 2). MVP пишет только 'user'.
--   2. CREATE TABLE lecture_chat_messages
--      — лента сообщений с soft-delete (deleted_at, deleted_by_id) и
--      денормализованным is_trainer_message (для быстрого фильтра
--      «только тренер» без join'а на Lecture.owner_id).
--      INDEX (lecture_id, created_at) — снапшот «последние N сообщений
--      лекции» отдаётся через ORDER BY created_at DESC LIMIT 100.
--   3. CREATE TABLE lecture_chat_mutes
--      — мьюты ученика в чате конкретной лекции. UNIQUE (lecture_id,
--      user_id) — один мьют на пару. MVP: действует до конца лекции,
--      снять — Phase 2.
--
-- Замечание про shadow-database (см. соседнюю миграцию KS-3930):
-- `prisma migrate dev` падает на legacy KS-3234 в shadow-БД из-за
-- отсутствия pg_trgm. Поэтому миграция написана вручную; на проде
-- применяется `prisma migrate deploy` через `kingside-api-migrations`.

CREATE TYPE "lecture_chat_message_kind" AS ENUM ('user', 'system');

CREATE TABLE "lecture_chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lecture_id" UUID NOT NULL,
    "author_id" UUID,
    "text" VARCHAR(500) NOT NULL,
    "kind" "lecture_chat_message_kind" NOT NULL DEFAULT 'user',
    "is_trainer_message" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lecture_chat_messages_lecture_id_created_at_idx"
    ON "lecture_chat_messages"("lecture_id", "created_at");

ALTER TABLE "lecture_chat_messages"
    ADD CONSTRAINT "lecture_chat_messages_lecture_id_fkey"
    FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lecture_chat_messages"
    ADD CONSTRAINT "lecture_chat_messages_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "lecture_chat_mutes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lecture_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "muted_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_chat_mutes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lecture_chat_mutes_lecture_id_user_id_key"
    ON "lecture_chat_mutes"("lecture_id", "user_id");

ALTER TABLE "lecture_chat_mutes"
    ADD CONSTRAINT "lecture_chat_mutes_lecture_id_fkey"
    FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lecture_chat_mutes"
    ADD CONSTRAINT "lecture_chat_mutes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lecture_chat_mutes"
    ADD CONSTRAINT "lecture_chat_mutes_muted_by_id_fkey"
    FOREIGN KEY ("muted_by_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
