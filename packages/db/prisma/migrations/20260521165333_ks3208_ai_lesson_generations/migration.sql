-- KS-3208 / ADR-074 §10 B4. Audit-журнал генераций пользовательских
-- курсов через AI-ассистента.
--
-- Каждый вызов tool'а `create_user_course` пишет строку `pending` с
-- исходным `plan_json` (вход модели); по факту создания курса статус
-- переключается на `created` и `created_course_id` ← id нового
-- `Course`; при ошибке — `failed` + `error`.
--
-- Шкала статусов хранится как `String` (без Prisma-enum) — добавление
-- новых статусов не должно тянуть миграцию.

CREATE TABLE "ai_lesson_generations" (
  "id"                UUID        NOT NULL,
  "user_id"           UUID        NOT NULL,
  "plan_json"         JSONB       NOT NULL,
  "status"            TEXT        NOT NULL,
  "created_course_id" UUID,
  "error"             TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_lesson_generations_pkey" PRIMARY KEY ("id")
);

-- FK на пользователя — каскад: удаление юзера сносит его audit-записи.
ALTER TABLE "ai_lesson_generations"
  ADD CONSTRAINT "ai_lesson_generations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK на курс — `ON DELETE SET NULL`: удаление курса не должно сносить
-- audit-запись, но `created_course_id` обнуляется (запись остаётся для
-- отчётности «сколько было успешных генераций», просто потерян линк).
ALTER TABLE "ai_lesson_generations"
  ADD CONSTRAINT "ai_lesson_generations_created_course_id_fkey"
  FOREIGN KEY ("created_course_id") REFERENCES "courses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Индекс «journal автора по времени» — для пагинации в audit-UI и
-- для rate-limit checks (хотя текущий rate-limit на Redis).
CREATE INDEX "ai_lesson_generations_user_id_created_at_idx"
  ON "ai_lesson_generations" ("user_id", "created_at" DESC);

-- Индекс по статусу — нужен для фоновых job'ов «найти все pending
-- старше N часов» (cleanup zombie-генераций, если такое появится).
CREATE INDEX "ai_lesson_generations_status_idx"
  ON "ai_lesson_generations" ("status");
