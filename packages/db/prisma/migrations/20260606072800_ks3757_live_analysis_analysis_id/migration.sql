-- KS-3757 / ADR-112 §4, §6. Binding live-трансляции к Analysis.
--
-- Шаги (порядок важен):
--   1. ALTER TABLE — добавить колонку `analysis_id` UUID NULL и FK на
--      `analyses(id)` с `ON DELETE SET NULL`. Удаление анализа сохраняет
--      запись трансляции для аудита, но обнуляет binding.
--   2. UPDATE — data-cleanup согласован с пользователем: функционал ещё
--      не запускался публично, легитимных активных трансляций без
--      binding нет. Все `active`-записи с `analysis_id IS NULL`
--      переводим в `closed`, чтобы partial UNIQUE индекс ниже не
--      получил коллизий с историческими записями ADR-110.
--   3. CREATE UNIQUE INDEX (partial) — «один автор × один анализ =
--      одна active-трансляция». Условие `WHERE status='active' AND
--      analysis_id IS NOT NULL` сознательно НЕ выражается в
--      `schema.prisma`: Prisma `@@unique` дал бы full-unique и
--      запретил бы закрытые трансляции на тот же анализ (ADR-112 §2.8).

-- 1) Колонка + FK
ALTER TABLE "live_analyses"
  ADD COLUMN "analysis_id" UUID;

ALTER TABLE "live_analyses"
  ADD CONSTRAINT "live_analyses_analysis_id_fkey"
  FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Data-cleanup: закрываем active без binding (см. ADR-112 §6)
UPDATE "live_analyses"
  SET "status" = 'closed', "closed_at" = NOW()
  WHERE "status" = 'active' AND "analysis_id" IS NULL;

-- 3) Partial UNIQUE: один автор × один анализ = одна active-трансляция
CREATE UNIQUE INDEX "live_analysis_owner_analysis_active_unique"
  ON "live_analyses" ("owner_id", "analysis_id")
  WHERE "status" = 'active' AND "analysis_id" IS NOT NULL;
