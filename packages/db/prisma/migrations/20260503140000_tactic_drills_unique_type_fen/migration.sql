-- KS-2229 (ADR-035 §6.3, Drills E2 indexer).
-- Уникальность по (type, fen) для дедупликации в индексаторе.
-- ON CONFLICT DO NOTHING на стороне Prisma (`createMany skipDuplicates`)
-- использует именно это ограничение.

BEGIN;

ALTER TABLE "tactic_drills"
  ADD CONSTRAINT "tactic_drills_type_fen_key" UNIQUE ("type", "fen");

COMMIT;
