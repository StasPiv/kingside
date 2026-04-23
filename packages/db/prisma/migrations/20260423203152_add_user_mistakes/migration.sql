-- L-31 (KS-1802): Дневник ошибок.
-- Агрегирует ошибки из двух источников (puzzle / game_review) в одной таблице.
-- Partial-уникальные индексы обеспечивают идемпотентность записи по источнику:
--   puzzle       — уникально (user_id, puzzle_id)
--   game_review  — уникально (user_id, game_id, ply)

CREATE TABLE "user_mistakes" (
    "id"          UUID        NOT NULL,
    "user_id"     UUID        NOT NULL,
    "source"      TEXT        NOT NULL,
    "puzzle_id"   TEXT,
    "game_id"     UUID,
    "ply"         INTEGER,
    "themes"      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mistakes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_mistakes_user_id_occurred_at_idx" ON "user_mistakes"("user_id", "occurred_at");
CREATE INDEX "user_mistakes_user_id_source_idx"      ON "user_mistakes"("user_id", "source");

-- Partial-уникальные индексы для идемпотентности по источнику.
CREATE UNIQUE INDEX "user_mistakes_puzzle_unique"
    ON "user_mistakes"("user_id", "puzzle_id")
    WHERE "source" = 'puzzle';

CREATE UNIQUE INDEX "user_mistakes_game_review_unique"
    ON "user_mistakes"("user_id", "game_id", "ply")
    WHERE "source" = 'game_review';

ALTER TABLE "user_mistakes"
    ADD CONSTRAINT "user_mistakes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_mistakes"
    ADD CONSTRAINT "user_mistakes_puzzle_id_fkey"
    FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_mistakes"
    ADD CONSTRAINT "user_mistakes_game_id_fkey"
    FOREIGN KEY ("game_id") REFERENCES "games"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
