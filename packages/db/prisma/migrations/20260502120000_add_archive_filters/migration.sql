-- KS-2210: сохранение фильтров архивного поиска на бэкенде.
-- Добавляем nullable JSONB-колонку archive_filters в таблицу users.
-- Backward-compatible: existing rows получат NULL по умолчанию.

ALTER TABLE "users"
  ADD COLUMN "archive_filters" JSONB;
