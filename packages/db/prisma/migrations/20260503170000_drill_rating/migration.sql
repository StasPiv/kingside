-- KS-2311 (methodology §10.12, Drills E6).
-- Drill-rating: Glicko-1 для users + фиксированный rating per drill +
-- attempt-level rating delta для daily-cap accounting.
--
-- BACKFILL `tactic_drills.rating` по difficulty bucket
-- (methodology §10.3): 1→1000, 2→1300, 3→1500, 4→1700, 5→2000.

BEGIN;

ALTER TABLE "users"
  ADD COLUMN "rating_drill"     INTEGER NOT NULL DEFAULT 1500,
  ADD COLUMN "rating_drill_dev" INTEGER NOT NULL DEFAULT 350;

ALTER TABLE "tactic_drills"
  ADD COLUMN "rating" INTEGER NOT NULL DEFAULT 1500;

-- BACKFILL по difficulty (методика §10.3).
UPDATE "tactic_drills"
   SET "rating" = CASE "difficulty"
                    WHEN 1 THEN 1000
                    WHEN 2 THEN 1300
                    WHEN 3 THEN 1500
                    WHEN 4 THEN 1700
                    WHEN 5 THEN 2000
                    ELSE 1500
                  END;

ALTER TABLE "tactic_drill_attempts"
  ADD COLUMN "rating_before" INTEGER,
  ADD COLUMN "rating_after"  INTEGER,
  ADD COLUMN "rating_capped" BOOLEAN NOT NULL DEFAULT FALSE;

-- Индекс для быстрых запросов «daily change за 24ч»
-- (methodology §10.11 daily cap).
CREATE INDEX "tactic_drill_attempts_user_rating_idx"
  ON "tactic_drill_attempts" ("user_id", "created_at")
  WHERE "rating_before" IS NOT NULL;

-- Индекс для leaderboard'а: топ по rating_drill + фильтр provisional.
-- (Минимум попыток 20, isHidden=false — фильтруется на уровне SQL.)
CREATE INDEX "users_rating_drill_idx"
  ON "users" ("rating_drill" DESC);

COMMIT;
