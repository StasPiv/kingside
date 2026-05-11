-- KS-2779. updatedAt на broadcast_rounds — для фильтра "недавно finished"
-- в `refreshNonTop20RoundStatuses` (зеркалирование статуса с Lichess).
ALTER TABLE "broadcast_rounds"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "broadcast_rounds_status_updated_at_idx"
  ON "broadcast_rounds" ("status", "updated_at");
