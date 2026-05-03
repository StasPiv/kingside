-- KS-2250-fix: добавляем `meta JSONB` в tactic_drills для UI-метаданных
-- (count-attackers требует highlightedSquare + attackerColor; find-all-checks
-- — expectedCount для прогресса). Прокидывается в `TacticDrillDto.meta`
-- через `buildDto`.

BEGIN;

ALTER TABLE "tactic_drills"
  ADD COLUMN IF NOT EXISTS "meta" JSONB;

COMMIT;
