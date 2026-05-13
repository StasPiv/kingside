-- KS-2940. Устраняем TOCTOU-race на уникальности имени в
-- (user_id, section, name) через unique index на уровне БД.
--
-- В KS-2927 проверка дубля сделана как pre-SELECT в сервисе —
-- при concurrent POST две транзакции могут пройти проверку и
-- одновременно вставить дубль. На UI-сценарии вероятность мизерная,
-- но закрываем на уровне БД.
--
-- Шаг 1: дедуп существующих дублей (идемпотентный).
--   Оставляем запись с самым ранним `created_at`; остальные удаляем.
--   Tie-breaker — `id` (чтобы при равенстве created_at результат был
--   детерминированным). На dev дублей нет (sanity-check выполнен);
--   в проде, если дублей нет — DELETE будет no-op.
--
-- Шаг 2: создание unique-индекса. Имя `saved_filters_user_section_name_uniq`
--   — соглашение в схеме (см. соседние unique-индексы в schema.prisma).

DELETE FROM "saved_filters" a
USING "saved_filters" b
WHERE a."id" <> b."id"
  AND a."user_id" = b."user_id"
  AND a."section" = b."section"
  AND a."name" = b."name"
  AND (
        a."created_at" > b."created_at"
        OR (a."created_at" = b."created_at" AND a."id" > b."id")
      );

CREATE UNIQUE INDEX "saved_filters_user_section_name_uniq"
    ON "saved_filters" ("user_id", "section", "name");
