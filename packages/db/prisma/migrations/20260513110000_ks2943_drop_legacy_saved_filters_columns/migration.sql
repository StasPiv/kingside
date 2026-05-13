-- KS-2943 / KS-2924 Phase D1. Удаляем legacy-колонки из saved_filters.
--
-- К этому моменту:
--   - данные перенесены в JSONB-колонку `params` миграцией KS-2926
--     (20260513091500_ks2926_saved_filters_migrate_workshop_params);
--   - legacy proxy `/analyses/filters` удалён в этом же релизе;
--   - фронт Мастерской переключён на `/api/user/saved-filters`
--     (KS-2933, KS-2931).
--
-- DROP COLUMN — безопасно: бизнес-кода, читающего эти поля, не
-- осталось (`grep -rn "savedFilter.category|tags|search|sortOrder"`
-- → пусто на момент применения миграции).

ALTER TABLE "saved_filters"
    DROP COLUMN "category",
    DROP COLUMN "tags",
    DROP COLUMN "search",
    DROP COLUMN "sort_order";
