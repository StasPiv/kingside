-- KS-3325 / ADR-078. Multi-source PGN для Opening Trainer.
-- Каждый репертуар может содержать 1..maxSourcesPerRepertoire (=20)
-- источников. Builder перестраивает tree с union edges по sourceIds.

CREATE TABLE "opening_repertoire_sources" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "repertoire_id"       UUID NOT NULL,
  "name"                TEXT,
  "pgn"                 TEXT NOT NULL,
  "source_kind"         TEXT NOT NULL,
  "source_analysis_id"  UUID,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "opening_repertoire_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opening_repertoire_sources_repertoire_id_fkey"
    FOREIGN KEY ("repertoire_id") REFERENCES "opening_repertoires"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "opening_repertoire_sources_source_kind_check"
    CHECK ("source_kind" IN ('pgn-upload', 'workshop-analysis', 'legacy-import'))
);

CREATE INDEX "opening_repertoire_sources_repertoire_id_idx"
  ON "opening_repertoire_sources"("repertoire_id");

CREATE INDEX "opening_repertoire_sources_repertoire_id_created_at_idx"
  ON "opening_repertoire_sources"("repertoire_id", "created_at");

-- Data-migration: для каждого существующего репертуара создаём один
-- legacy-source с его текущим pgn. После этого builder при apply'е
-- пересоберёт tree с sourceIds = [<legacy-source-id>].
-- Пересборка деревьев — отдельный backfill-скрипт (не в SQL), потому
-- что builder — TypeScript. Здесь только INSERT row'ов.
INSERT INTO "opening_repertoire_sources" (
  "id",
  "repertoire_id",
  "name",
  "pgn",
  "source_kind",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  "id",
  NULL,
  "pgn",
  'legacy-import',
  "created_at",
  "updated_at"
FROM "opening_repertoires";
