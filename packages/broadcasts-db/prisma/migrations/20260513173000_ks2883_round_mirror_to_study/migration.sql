-- KS-2883 / ADR-060 §3.7 B10. Флаг авто-зеркалирования раунда в студию.
-- `mirror_to_study` поднимает админ. `mirrored_study_slug` сохраняется
-- после успешного POST /api/studies/from-broadcast-round и работает как
-- idempotent-маркер для sync vs create.

ALTER TABLE "broadcast_rounds"
  ADD COLUMN "mirror_to_study"     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "mirrored_study_slug" TEXT;

CREATE INDEX "broadcast_rounds_mirror_to_study_idx"
  ON "broadcast_rounds" ("mirror_to_study");
