-- KS-3930 / ADR-118 §2.1, §3.2. Allowlist-доступ к лекциям.
--
-- Три изменения, выполняются отдельными statement'ами:
--   1. ALTER TYPE lecture_visibility ADD VALUE 'restricted'
--      — третий уровень видимости поверх 'public' / 'unlisted'.
--   2. CREATE TYPE lecture_access_subject AS ENUM ('user', 'course')
--      — дискриминатор полиморфного allowlist'а. MVP использует только
--      'user'; 'course' заведён как задел (см. ADR §2.2: при попытке
--      создать grant subjectType='course' API вернёт 400, пока не
--      появится Course/Enrollment).
--   3. CREATE TABLE lecture_access_grants — allowlist-записи.
--      Три индекса:
--        * (lecture_id, subject_type, subject_id) UNIQUE — защита от дублей.
--        * (subject_type, subject_id) — обратный лукап «какие лекции
--          доступны конкретному субъекту» для GET /my/lectures.
--        * (lecture_id) — список allowlist'а лекции для GET /lectures/:id/access.
--
-- Целостность по subject_id поддерживается обработчиком удаления User
-- (см. KS-3935 A06: cleanup в UsersService.delete).
--
-- Замечание про shadow-database: `prisma migrate dev` падает на
-- legacy KS-3234 из-за отсутствия pg_trgm в shadow-БД (devops issue,
-- не блокер). Миграция написана вручную; на проде применяется
-- `prisma migrate deploy` через `kingside-api-migrations`.
--
-- Замечание про ALTER TYPE ADD VALUE: PostgreSQL 12+ разрешает это
-- внутри транзакции при условии, что новое значение НЕ используется
-- в той же транзакции. Здесь 'restricted' нигде дальше в миграции не
-- появляется (новая таблица использует другой enum lecture_access_subject),
-- так что одиночный файл миграции безопасен.

ALTER TYPE "lecture_visibility" ADD VALUE 'restricted';

CREATE TYPE "lecture_access_subject" AS ENUM ('user', 'course');

CREATE TABLE "lecture_access_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lecture_id" UUID NOT NULL,
    "subject_type" "lecture_access_subject" NOT NULL,
    "subject_id" UUID NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lecture_access_unique"
    ON "lecture_access_grants" ("lecture_id", "subject_type", "subject_id");

CREATE INDEX "lecture_access_subject_lookup"
    ON "lecture_access_grants" ("subject_type", "subject_id");

CREATE INDEX "lecture_access_lecture_lookup"
    ON "lecture_access_grants" ("lecture_id");

ALTER TABLE "lecture_access_grants"
    ADD CONSTRAINT "lecture_access_grants_lecture_id_fkey"
    FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lecture_access_grants"
    ADD CONSTRAINT "lecture_access_grants_granted_by_id_fkey"
    FOREIGN KEY ("granted_by_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
