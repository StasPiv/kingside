-- KS-2250 (ADR-035 §11, Drills E6).
-- Бронирование daily-drill'а: одна позиция на дату для Telegram-рассылки.
-- Lazy fill: запись создаётся при первом GET /api/tactic-drill/daily?date=ISO.

BEGIN;

CREATE TABLE "daily_tactic_drills" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "date"          DATE NOT NULL,
  "drill_id"      UUID NOT NULL,
  "drill_type"    TEXT NOT NULL,
  "difficulty"    TEXT NOT NULL,
  "is_repeat"     BOOLEAN NOT NULL DEFAULT FALSE,
  "original_date" DATE,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_tactic_drills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_tactic_drills_date_key"
  ON "daily_tactic_drills"("date");

CREATE INDEX "daily_tactic_drills_drill_id_idx"
  ON "daily_tactic_drills"("drill_id");

CREATE INDEX "daily_tactic_drills_drill_type_date_idx"
  ON "daily_tactic_drills"("drill_type", "date");

ALTER TABLE "daily_tactic_drills"
  ADD CONSTRAINT "daily_tactic_drills_drill_id_fkey"
  FOREIGN KEY ("drill_id") REFERENCES "tactic_drills"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
