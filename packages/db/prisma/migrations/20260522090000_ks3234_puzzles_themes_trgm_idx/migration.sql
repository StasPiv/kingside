-- KS-3234. /precision не грузит пазлы с фильтром «Спасение в ничью»
-- (themes LIKE '%saveEquality%') — фронт получает таймаут.
--
-- Диагностика на проде (2026-05-22):
--   GET /puzzles/browse?themes=saveEquality                → ~40c
--   GET /puzzles/browse?themes=saveEquality&source=generated → 0.13c
--   GET /puzzles/browse?themes=convertAdvantage            → 0.14c
--   GET /puzzles/browse?themes=mateIn1                     → 0.36c
--
-- Корень: после KS-2557 на `puzzles` есть индекс `puzzles_created_at_idx`,
-- и planner для `ORDER BY p.created_at DESC LIMIT 21` берёт Backward
-- Index Scan, пробегая строки по убыванию даты и фильтруя по LIKE.
-- Для популярных тем (lichess: mateIn1; convertAdvantage у нас) — top-21
-- набирается за миллисекунды. Для редких подстрок (`saveEquality` — у
-- нас сейчас немного таких пазлов, а в индексе сверху массив свежих
-- lichess-импортов) — planner перебирает миллионы строк перед тем как
-- набрать LIMIT. Гипотеза «битый пазл валит весь list-запрос» (см.
-- описание KS-3234) не подтвердилась — HTTP 200 отдаётся, но фронт
-- считает таймаут ошибкой.
--
-- Фикс: GIN pg_trgm индекс на `puzzles.themes`. Planner для LIKE с
-- substring сможет идти через GIN — найти все строки с подстрокой за
-- миллисекунды, потом отсортировать по created_at и взять LIMIT.
--
-- Так же, как KS-2093 для `archive_games` (white_name/black_name/event)
-- — там тот же шаблон.
--
-- pg_trgm extension включаем явно: на kingside DB (отдельная от
-- archive_games) он мог быть не активен. CREATE EXTENSION IF NOT
-- EXISTS — идемпотентно, requires superuser. Если у DB-роли нет SUPERUSER
-- — devops может выполнить `CREATE EXTENSION pg_trgm;` руками один раз,
-- следующий `prisma migrate deploy` повторно безопасно перепустит.
--
-- CONCURRENTLY обязательно: `puzzles` — большая prod-таблица (~6M строк
-- после lichess-импорта KS-2556), ACCESS EXCLUSIVE lock минуты-десятки
-- минут недопустим. Prisma migrate deploy выполняет statement'ы
-- PostgreSQL-миграций вне транзакции (auto-commit), что совместимо.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS puzzles_themes_trgm_idx
  ON puzzles USING gin (themes gin_trgm_ops);
