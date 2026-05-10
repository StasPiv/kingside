-- KS-2698: очистить kingside_archive (DROP SCHEMA + CREATE), чтобы потом
-- prisma db push накатил archive-схему с нуля. Используется вместо DROP
-- DATABASE, потому что prisma db execute оборачивает в транзакцию, а
-- DROP DATABASE в транзакции запрещён.

-- Закрыть чужие коннекты к этой БД (importer мог переподключиться при restart).
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid();

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO kingside;
GRANT ALL ON SCHEMA public TO public;
