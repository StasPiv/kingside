-- Drop archive tables (ADR-018 §2.1, §2.8 фаза 3, KS-1663 [B3]).
-- Данные архива уже живут в apps/archive-service (packages/archive-db),
-- soak завершён, API-роуты /api/archive/* не обслуживают трафик.
--
-- CASCADE — на случай забытых внешних ссылок (FK/индексов); после soak
-- легальных зависимостей быть не должно, но страхуемся.
-- Порядок: сначала таблицы-"листья" (archive_game_positions, position_stats),
-- затем archive_games (FK → archive_sources, archive_imports),
-- затем archive_imports (FK → archive_sources), последним archive_sources.
-- С CASCADE порядок нефункционален, но читаемость выше.
DROP TABLE IF EXISTS "archive_game_positions" CASCADE;
DROP TABLE IF EXISTS "position_stats" CASCADE;
DROP TABLE IF EXISTS "archive_games" CASCADE;
DROP TABLE IF EXISTS "archive_imports" CASCADE;
DROP TABLE IF EXISTS "archive_sources" CASCADE;
