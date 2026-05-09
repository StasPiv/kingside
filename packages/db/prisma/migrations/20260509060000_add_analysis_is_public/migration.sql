-- KS-2600 / ADR-051 §3 share-1. Флаг публичности анализа.
--
-- ADD COLUMN с DEFAULT false — Postgres 11+ выполняет это как
-- метаданные таблицы (без переписи строк), поэтому миграция
-- безопасна на больших таблицах и не теряет данные. Все существующие
-- пользовательские анализы остаются приватными (is_public=false).
--
-- IF NOT EXISTS — идемпотентность для повторного запуска.

ALTER TABLE "analyses"
  ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT false;
