-- KS-4604. Индекс под сортировку каталога `/tactic-puzzles/browse` по
-- `(createdAt DESC, id DESC)` — keyset-пагинация «свежие сверху».
-- Без индекса Postgres делает sort всей выборки (десятки тысяч строк
-- — секунды cold cache, ms hot); с индексом — range scan O(log N)
-- независимо от размера корпуса.
--
-- Концептуально дублирует `@@index([createdAt(sort: Desc), id(sort: Desc)])`
-- в schema.prisma. `IF NOT EXISTS` — для совместимости с CONCURRENTLY-
-- накаткой devops'ом, если потребуется сделать руками вне миграции.

CREATE INDEX IF NOT EXISTS "tactic_puzzles_created_at_id_desc_idx"
  ON "tactic_puzzles" ("created_at" DESC, "id" DESC);
