-- KS-2926 / KS-2924 Phase A2. Backfill `params` для существующих
-- saved_filters в секции 'workshop' — переносим плоские колонки
-- (category, tags, search, sort_order) в JSONB-структуру, форма
-- которой соответствует `SavedFilterParams.workshop` из
-- @kingside/shared (см. KS-2928).
--
-- Условие `params = '{}'::jsonb` делает миграцию идемпотентной:
-- повторный прогон не затронет уже мигрированные записи (а также
-- записи, созданные новым API уже с непустым params).
--
-- Преобразования (см. план KS-2924 §3.4):
--   - category, search, sort_order: пустые строки трактуются как
--     отсутствие значения → NULL через NULLIF(col, '').
--   - tags: CSV-строка → JSON-массив через
--     to_jsonb(string_to_array(tags, ',')). Пустая строка/NULL →
--     пустой массив [].
--
-- Поле `section` в JSON params не добавляется — дискриминатор
-- хранится на колонке `saved_filters.section`. Сервисный слой
-- (KS-2927) при чтении подмешивает section в DTO, при записи —
-- срезает из JSONB.
--
-- Плоские колонки НЕ удаляются — это Phase D (KS-2924 §5),
-- удалятся после нескольких релизов сосуществования.

UPDATE saved_filters
SET params = jsonb_build_object(
    'category',  NULLIF(category, ''),
    'tags',      CASE
                     WHEN COALESCE(tags, '') = '' THEN '[]'::jsonb
                     ELSE to_jsonb(string_to_array(tags, ','))
                 END,
    'search',    NULLIF(search, ''),
    'sortOrder', NULLIF(sort_order, '')
)
WHERE section = 'workshop'
  AND params = '{}'::jsonb;
