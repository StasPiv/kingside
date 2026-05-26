-- KS-3342 / ADR-079. Precision-рейтинг (Glicko-1) для авто-подбора
-- задач по уровню. Отдельная таблица от User.ratingPuzzle —
-- precision имеет свою кривую сложности.

CREATE TABLE "user_precision_ratings" (
  "user_id"         UUID NOT NULL,
  "rating"          DOUBLE PRECISION NOT NULL DEFAULT 1500,
  "deviation"       DOUBLE PRECISION NOT NULL DEFAULT 350,
  "volatility"      DOUBLE PRECISION NOT NULL DEFAULT 0.06,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_precision_ratings_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_precision_ratings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Расширение precision_attempts полями для дельты рейтинга.
-- NULL для legacy-attempt'ов (backfill не делаем — ADR §3.6.3),
-- а также для гостей / hidden-test / self-created (anti-cheat).
ALTER TABLE "precision_attempts"
  ADD COLUMN "rating_before" DOUBLE PRECISION,
  ADD COLUMN "rating_after"  DOUBLE PRECISION;
