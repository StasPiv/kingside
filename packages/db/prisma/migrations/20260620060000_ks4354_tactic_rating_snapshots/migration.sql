-- KS-4354 / ADR-136 §3.6. Дневной снимок рейтинга пользователя по
-- разделу «Точность». Источник графика динамики рейтинга на
-- /tactic-puzzles/stats. По образцу `puzzle_rating_snapshots`
-- (ADR-082) с двумя отличиями:
--   * `rating: DOUBLE PRECISION` (а не INT) — `user_tactic_ratings.rating`
--     тоже хранится как DOUBLE PRECISION;
--   * FK на users — `ON DELETE CASCADE` (удаление пользователя сносит
--     его историю по «Точности»).
--
-- UNIQUE(user_id, date) — гарантия идемпотентности шедулера: повторный
-- запуск за один день не создаёт дубликат, делается upsert.

-- CreateTable
CREATE TABLE "tactic_rating_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "date" DATE NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "solved" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tactic_rating_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tactic_rating_snapshots_user_id_idx" ON "tactic_rating_snapshots"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tactic_rating_snapshots_user_id_date_key" ON "tactic_rating_snapshots"("user_id", "date");

-- AddForeignKey
ALTER TABLE "tactic_rating_snapshots" ADD CONSTRAINT "tactic_rating_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
