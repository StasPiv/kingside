-- KS-4927 / ADR-163 §3. Гибкие расписания занятий:
--  1) StudySchedule: несколько тренировок на пользователя (@unique снят),
--     + name; дни/время переезжают в новую таблицу слотов.
--  2) study_schedule_slots: 1..7 временных диапазонов на тренировку.
--  3) Data-миграция: каждое существующее расписание получает один слот
--     из своих days_of_week + time_local — настройки не теряются.

-- 1. Имя тренировки; бэкфилл по locale пользователя (имя редактируемое,
--    локализация дальше не нужна — ADR-163 §3).
ALTER TABLE "study_schedules" ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Занятие';
UPDATE "study_schedules" s
SET "name" = 'Study'
FROM "users" u
WHERE s."user_id" = u."id" AND COALESCE(u."locale", 'en') <> 'ru';

-- 2. Снять 1:1: unique → обычный индекс.
DROP INDEX "study_schedules_user_id_key";
CREATE INDEX "study_schedules_user_id_idx" ON "study_schedules"("user_id");

-- 3. Таблица слотов.
CREATE TABLE "study_schedule_slots" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "days_of_week" INTEGER[],
    "time_local" TEXT NOT NULL,
    "session_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_schedule_slots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "study_schedule_slots_schedule_id_idx" ON "study_schedule_slots"("schedule_id");

ALTER TABLE "study_schedule_slots"
    ADD CONSTRAINT "study_schedule_slots_schedule_id_fkey" FOREIGN KEY ("schedule_id")
    REFERENCES "study_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Data-миграция: один слот на каждое существующее расписание
--    (gen_random_uuid() встроен в PostgreSQL 13+).
INSERT INTO "study_schedule_slots" ("id", "schedule_id", "days_of_week", "time_local", "session_minutes")
SELECT gen_random_uuid(), "id", "days_of_week", "time_local", NULL
FROM "study_schedules";

-- 5. Старые колонки больше не читаются.
ALTER TABLE "study_schedules" DROP COLUMN "days_of_week";
ALTER TABLE "study_schedules" DROP COLUMN "time_local";
