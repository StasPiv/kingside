-- KS-2925 / KS-2924 Phase A1. Расширяем saved_filters новыми полями
-- для поддержки секции `archive` (план:
-- docs/architecture/KS-2924-saved-filters-archive.md §3.1, §5 Phase A1).
--
-- `section` — дискриминатор секции: 'workshop' (исторические записи)
--   или 'archive'. Default 'workshop' — все существующие строки
--   относятся к workshop, поскольку до KS-2924 секция была одна.
-- `params` — JSONB с типизированным набором параметров фильтра,
--   форма соответствует SavedFilterParams из @kingside/shared
--   (KS-2928). На v1 — default '{}', реальная миграция данных из
--   плоских колонок выполняется в Phase A2/A3.
-- `updated_at` — для оптимистичной синхронизации FE-кэша и
--   сортировки «по последнему изменению».
--
-- Индекс (user_id, section, created_at DESC) — основной путь чтения
-- saved-filters на FE (последние N для текущей секции).
-- CHECK на section — гарантия доменного множества; синхронен с
-- TypeScript-типом SavedFilterSection. Расширять CHECK нужно вместе
-- с типом (KS-2924 §3.1).
--
-- Плоские колонки category / tags / search / sort_order оставлены —
-- они будут удалены в Phase D (KS-2924 §5) после нескольких релизов
-- сосуществования двух форм данных.

ALTER TABLE "saved_filters"
    ADD COLUMN "section"    TEXT  NOT NULL DEFAULT 'workshop',
    ADD COLUMN "params"     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "saved_filters_user_section_idx"
    ON "saved_filters" ("user_id", "section", "created_at" DESC);

ALTER TABLE "saved_filters"
    ADD CONSTRAINT "saved_filters_section_check"
    CHECK ("section" IN ('workshop','archive'));
