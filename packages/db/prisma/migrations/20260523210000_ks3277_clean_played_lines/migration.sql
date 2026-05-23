-- KS-3277 / ADR-077 follow-up.
-- Поля для логики «учим дерево до полного освоения без ошибок»:
--   clean_played_lines       — edges, пройденные без ошибок (для tree-complete детекции)
--   current_line_had_wrong   — был ли хотя бы один wrong в текущей линии
--   line_start_index         — индекс в currentPath, с которого началась текущая линия
ALTER TABLE "opening_trainer_sessions"
  ADD COLUMN "clean_played_lines" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "current_line_had_wrong" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "line_start_index" INTEGER NOT NULL DEFAULT 0;
