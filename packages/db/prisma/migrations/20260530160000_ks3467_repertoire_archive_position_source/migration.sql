-- KS-3467 / ADR-090 §8 B0. Поддержка нового sourceKind 'archive-position'
-- (репертуар собран из мастер-партий 2400+ по позиции) + опциональная
-- ссылка на исходную archive_games-партию для трассировки.

ALTER TABLE "opening_repertoire_sources"
  ADD COLUMN "archive_game_id" UUID;

-- Расширяем whitelist sourceKind. Postgres не поддерживает ALTER
-- CONSTRAINT — drop & recreate.
ALTER TABLE "opening_repertoire_sources"
  DROP CONSTRAINT "opening_repertoire_sources_source_kind_check";

ALTER TABLE "opening_repertoire_sources"
  ADD CONSTRAINT "opening_repertoire_sources_source_kind_check"
    CHECK ("source_kind" IN (
      'pgn-upload',
      'workshop-analysis',
      'legacy-import',
      'archive-position'
    ));
