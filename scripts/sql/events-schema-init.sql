-- KS-4690 / ADR-147 §2.2 §8 — инициализация схемы events в kingside-db.
--
-- Применяется ВРУЧНУЮ один раз после первого перезапуска инстанса с
-- параметр-группой kingside-postgres16 (shared_preload_libraries содержит
-- pg_cron). До перезапуска `CREATE EXTENSION pg_cron` упадёт с ошибкой
-- «pg_cron must be loaded via shared_preload_libraries».
--
-- Способ запуска (из api-контейнера на проде):
--   apt-get update && apt-get install -y postgresql-client
--   psql "$DATABASE_URL" -f /tmp/events-schema-init.sql
--
-- Файл идемпотентен — можно прогонять повторно.

\set ON_ERROR_STOP on

BEGIN;

-- 1. Extensions.
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_cron;  -- pg_cron живёт в schema cron в БД cron.database_name=kingside.

-- 2. Изолированная схема для аналитики.
CREATE SCHEMA IF NOT EXISTS events;
COMMENT ON SCHEMA events
  IS 'KS-4690 / ADR-147 §2.2 — аналитические события (actor_events, matviews). Изолирована от public.';

-- 3. Роль events_writer (LOGIN-роль для апи).
--    Пароль задаётся приложением через secrets (см. §8 T1c). Здесь — без пароля,
--    приложение выполнит `ALTER ROLE events_writer WITH PASSWORD '<...>'` из secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_writer') THEN
    CREATE ROLE events_writer LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END$$;

-- Минимальные права: USAGE на схему, INSERT/SELECT на текущие и будущие
-- таблицы внутри events. Public/другие схемы — без доступа.
GRANT USAGE ON SCHEMA events TO events_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA events
  GRANT INSERT, SELECT ON TABLES TO events_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA events
  GRANT USAGE, SELECT ON SEQUENCES TO events_writer;

-- Также пусть видит matviews (через SELECT на табличные объекты — matviews
-- покрываются default privileges на TABLES в Postgres 16).

-- На текущий момент таблиц в events нет — они появятся в T1b (KS-4691 backend
-- migration). До этого `\dt events.*` пуст. Default privileges применятся
-- автоматически к новым таблицам.

-- Public нельзя читать events_writer'ом — явно отзовём USAGE с public.
REVOKE ALL ON SCHEMA public FROM events_writer;

-- 4. pg_cron job для pg_partman.run_maintenance_proc().
--    Регистрируется ЗАРАНЕЕ. partman.run_maintenance_proc() пробегает по
--    зарегистрированным parent-таблицам в partman.part_config. Пока T1b не
--    добавит туда events.actor_events — процедура отрабатывает no-op.
--    Параметры партиционирования (weekly, retention 90 дней) применяются
--    в T1b при вызове partman.create_parent(...).
SELECT cron.schedule(
  'events-partman-maintenance',
  '@hourly',
  $$CALL partman.run_maintenance_proc()$$
)
WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'events-partman-maintenance'
);

COMMIT;

-- Проверки:
--   SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_partman','pg_cron');
--   SELECT nspname FROM pg_namespace WHERE nspname = 'events';
--   SELECT rolname FROM pg_roles WHERE rolname = 'events_writer';
--   SELECT jobname, schedule, command, active FROM cron.job WHERE jobname='events-partman-maintenance';
