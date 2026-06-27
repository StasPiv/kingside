-- KS-4674 / ADR-146. Админский CRUD дебютных репертуаров: расширяем
-- `opening_repertoires` для двойственной сущности (пользовательские +
-- админские демо в одной таблице). См. ADR-146 §2.1, §2.2, §2.5.

-- 1. user_id больше не NOT NULL: админские (is_demo=true) хранятся с NULL.
ALTER TABLE "opening_repertoires"
    ALTER COLUMN "user_id" DROP NOT NULL;

-- 2. Новые колонки.
--   slug    — стабильный URL-идентификатор демо-репертуара (NULL у юзерских).
--   is_demo — флаг «админский/демо» (двойственная сущность в одной таблице).
--   is_published — для админских черновиков (только true видны публично).
ALTER TABLE "opening_repertoires"
    ADD COLUMN "slug" TEXT,
    ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT false;

-- 3. Partial UNIQUE по slug только среди is_demo=true. Prisma `@@unique`
--    не поддерживает partial — делаем raw. У пользовательских slug
--    остаётся NULL и uniqueness не проверяется.
CREATE UNIQUE INDEX "opening_repertoires_demo_slug_uniq"
    ON "opening_repertoires" ("slug")
    WHERE "is_demo" = true;

-- 4. Доп. индекс по slug (general, не partial) — для подсказок плана и
--    join'ов; Prisma тоже его декларирует, держим в синхроне.
CREATE INDEX "opening_repertoires_slug_idx"
    ON "opening_repertoires" ("slug");

-- 5. Индекс публичной выборки `/opening-trainer/demo`:
--    `WHERE is_demo=true AND is_published=true ORDER BY created_at DESC`.
CREATE INDEX "opening_repertoires_is_demo_is_published_created_at_idx"
    ON "opening_repertoires" ("is_demo", "is_published", "created_at" DESC);

-- 6. CHECK инвариант: ровно одна из двух конфигураций владения.
--    - Админский: is_demo=true AND user_id IS NULL
--    - Пользовательский: is_demo=false AND user_id IS NOT NULL
--    Защита от случайного INSERT с противоречивым состоянием.
ALTER TABLE "opening_repertoires"
    ADD CONSTRAINT "opening_repertoires_demo_user_invariant_check"
    CHECK (
        (is_demo = true AND user_id IS NULL)
        OR
        (is_demo = false AND user_id IS NOT NULL)
    );
