-- KS-4919. Резолв puzzle-шага занятия падал по таймауту шлюза (15 с):
-- фильтр string_to_array(themes,' ') @> ARRAY[...] в findPuzzlesRandom
-- сканировал весь банк (LIKE contains в других путях — так же).
-- GIN-индекс по массиву тем делает containment индексным; ORDER BY
-- random() после фильтра сортирует уже узкое подмножество.
--
-- Без CONCURRENTLY: prisma migrate deploy выполняет миграции в
-- транзакции. Построение блокирует запись в puzzles (импорты редки),
-- чтение не блокируется.
CREATE INDEX IF NOT EXISTS "puzzles_themes_tokens_gin"
    ON "puzzles" USING GIN (string_to_array("themes", ' '));
