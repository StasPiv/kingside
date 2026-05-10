-- KS-2698: создать БД kingside_archive для локального tactic-worker / archive-importer.
-- Postgres не поддерживает IF NOT EXISTS для CREATE DATABASE. Скрипт идемпотентен
-- через ON ERROR — если БД уже есть, выполнение упадёт с 42P04 (duplicate_database),
-- bash-обёртка в run_init_archive_db ловит код возврата и трактует как «уже создана».
CREATE DATABASE kingside_archive OWNER kingside;
