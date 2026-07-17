-- ADR-166 (KS-4973): явный провенанс импорта партий.
-- Значения: manual | external_lichess | external_chesscom | auto_lichess | auto_chesscom.
ALTER TABLE "pgn_imports" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';

-- Бэкфилл существующих строк по fileName (ADR-166 §2.1): авто-импорт
-- трекинга помечен именем "study-auto (<provider>)"; остальное — manual (default).
UPDATE "pgn_imports" SET "origin" = 'auto_lichess'
  WHERE "file_name" LIKE 'study-auto (lichess)%';
UPDATE "pgn_imports" SET "origin" = 'auto_chesscom'
  WHERE "file_name" LIKE 'study-auto (chesscom)%';
