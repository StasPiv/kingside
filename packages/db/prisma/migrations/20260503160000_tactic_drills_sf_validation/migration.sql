-- KS-2247 (ADR-035 §6.3 R5, Drills E5).
-- Поля для Stockfish-валидации drill'ов с риском неоднозначности.
-- backward-compatible: NULL/false по умолчанию → текущие записи в
-- `tactic_drills` остаются «не валидированными» и не отбраковываются.

BEGIN;

ALTER TABLE "tactic_drills"
  ADD COLUMN "sf_validated_at" TIMESTAMP(3),
  ADD COLUMN "sf_rejected" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "sf_rejection_reason" TEXT;

-- Индекс для scheduler'а: «найти next-batch не валидированных drill'ов».
CREATE INDEX "tactic_drills_sf_validated_at_idx"
  ON "tactic_drills" ("sf_validated_at");

COMMIT;
