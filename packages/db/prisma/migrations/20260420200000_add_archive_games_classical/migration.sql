-- AlterTable archive_games — add time-control classification columns (ADR-015 §2.3, §3.2).
-- Safe migration: new nullable/defaulted columns, existing rows receive defaults.
ALTER TABLE "archive_games" ADD COLUMN "time_control" TEXT;
ALTER TABLE "archive_games" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "archive_games" ADD COLUMN "is_classical" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex — partial index для быстрой выборки классических партий
-- (is_classical — производное от category, но стабильно фильтрует по булеану без CHECK).
CREATE INDEX "archive_games_classical_played_at_idx"
  ON "archive_games" ("played_at" DESC, "id" DESC)
  WHERE "is_classical" = true;
