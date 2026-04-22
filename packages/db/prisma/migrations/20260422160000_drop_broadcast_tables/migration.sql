-- Drop broadcast tables (ADR-021 §2.1, M2-cleanup, KS-1697).
-- Данные broadcasts уже живут в apps/broadcast-service (packages/broadcasts-db),
-- frontend cutover закрыт (KS-1699), broadcasts.kingside.site/broadcasts
-- обслуживает прод-трафик, старые роуты /broadcasts/* в apps/api удалены.
--
-- CASCADE — на случай забытых внешних ссылок (FK/индексов); в packages/db
-- граф broadcast → broadcast_rounds → broadcast_games замкнут внутри себя,
-- наружу FK нет (нет FK на users), но страхуемся.
-- Порядок: сначала таблица-"лист" (broadcast_games),
-- затем broadcast_rounds (FK → broadcasts), последним broadcasts.
-- С CASCADE порядок нефункционален, но читаемость выше.
DROP TABLE IF EXISTS "broadcast_games" CASCADE;
DROP TABLE IF EXISTS "broadcast_rounds" CASCADE;
DROP TABLE IF EXISTS "broadcasts" CASCADE;
