-- KS-2698: DROP kingside_archive перед повторным накатом archive-схемы.
-- Используется только для исправления изначальной ошибки наката (вместо
-- archive миграций были применены main миграции из-за prisma.config.ts).
-- В обычной работе НЕ нужен.

-- Закрываем активные коннекты (importer мог переподключиться при restart).
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = 'kingside_archive' AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS kingside_archive;
