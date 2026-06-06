-- KS-3783 / ADR-113 §2. Модель Lecture — лекция тренера.
--
-- Базовая сущность страницы тренера. Состояние через enum lecture_status
-- (scheduled → live → recorded; либо cancelled). Видимость публичная по
-- умолчанию (lecture_visibility=public; unlisted — для лекций по ссылке).
--
-- `live_analysis_id` — опциональная привязка к LiveAnalysis (тот же владелец
-- ведёт лекцию через свою активную трансляцию анализа). ON DELETE SET NULL —
-- удаление трансляции не сносит запись лекции, только обнуляет binding.
--
-- Уникальность «одна активная лекция на одну live-сессию» выражается через
-- partial UNIQUE на (live_analysis_id) WHERE status='live'. В schema.prisma
-- не выражается: @@unique дал бы full-unique и запретил бы любые лекции
-- (recorded / cancelled), привязанные к той же live-сессии в истории.

-- CreateEnum
CREATE TYPE "lecture_status" AS ENUM ('scheduled', 'live', 'recorded', 'cancelled');

-- CreateEnum
CREATE TYPE "lecture_visibility" AS ENUM ('public', 'unlisted');

-- CreateTable
CREATE TABLE "lectures" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "status" "lecture_status" NOT NULL DEFAULT 'scheduled',
    "visibility" "lecture_visibility" NOT NULL DEFAULT 'public',
    "live_analysis_id" UUID,
    "recording_id" UUID,
    "media_url" TEXT,
    "media_kind" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lectures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (фильтр на странице тренера: «мои <status>»)
CREATE INDEX "lectures_owner_id_status_idx"
  ON "lectures"("owner_id", "status");

-- CreateIndex (список ближайших / будущих: WHERE status='scheduled'
-- ORDER BY scheduled_at ASC)
CREATE INDEX "lectures_status_scheduled_at_idx"
  ON "lectures"("status", "scheduled_at");

-- AddForeignKey: owner
ALTER TABLE "lectures"
  ADD CONSTRAINT "lectures_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: liveAnalysis
ALTER TABLE "lectures"
  ADD CONSTRAINT "lectures_live_analysis_id_fkey"
  FOREIGN KEY ("live_analysis_id") REFERENCES "live_analyses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial UNIQUE: одна активная лекция на одну live-сессию. Не выражается
-- через @@unique в schema.prisma — full-unique запретил бы любые лекции в
-- статусах recorded/cancelled, привязанные к той же live-сессии в истории.
CREATE UNIQUE INDEX "lecture_live_analysis_id_active_unique"
  ON "lectures" ("live_analysis_id")
  WHERE "status" = 'live' AND "live_analysis_id" IS NOT NULL;
