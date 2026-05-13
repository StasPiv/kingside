-- KS-2884 / ADR-060 §3.7 B11. Источник происхождения StudyChapter.
-- Нужен broadcast-зеркалу для идемпотентного sync (матчинг главы по
-- broadcastGameId). FK не ставим — broadcast-модели в отдельной БД
-- (ADR-021 §2.1), храним UUID как обычное значение.

ALTER TABLE "study_chapters"
  ADD COLUMN "from_kind" TEXT,
  ADD COLUMN "from_ref_id" UUID;

CREATE INDEX "study_chapters_study_id_from_ref_id_idx"
  ON "study_chapters" ("study_id", "from_ref_id");
