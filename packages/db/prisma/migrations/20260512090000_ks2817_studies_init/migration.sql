-- KS-2815 / ADR-059 / KS-2817 (T2). Studies MVP — две новые таблицы:
-- `studies` (контейнер) и `study_chapters` (главы как pgn-блобы).
-- Чистое CREATE TABLE без ALTER существующих таблиц — миграция
-- применима на staging/prod без даунтайма.
--
-- Семантика и индексы согласованы с §B.3 KS-2815-studies-standalone:
--   - studies(owner_id, slug)        UNIQUE — slug-namespace per-owner.
--   - studies(owner_id, updated_at)         — listing «мои студии».
--   - studies(is_public, updated_at)        — каталог публичных.
--   - study_chapters(study_id, order_idx) UNIQUE — стабильный порядок.
--   - study_chapters(study_id)              — выборка глав одной студии.
--
-- CASCADE на ownerId / studyId — удаление пользователя сносит студии
-- каскадом глав; удаление студии сносит её главы.

-- CreateTable
CREATE TABLE "studies" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "chapters_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_chapters" (
    "id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order_idx" INTEGER NOT NULL,
    "pgn" TEXT NOT NULL,
    "start_fen" TEXT,
    "orientation" TEXT NOT NULL DEFAULT 'white',
    "mode" TEXT NOT NULL DEFAULT 'analysis',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "studies_owner_id_slug_key" ON "studies"("owner_id", "slug");

-- CreateIndex
CREATE INDEX "studies_owner_id_updated_at_idx" ON "studies"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "studies_is_public_updated_at_idx" ON "studies"("is_public", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "study_chapters_study_id_order_idx_key" ON "study_chapters"("study_id", "order_idx");

-- CreateIndex
CREATE INDEX "study_chapters_study_id_idx" ON "study_chapters"("study_id");

-- AddForeignKey
ALTER TABLE "studies" ADD CONSTRAINT "studies_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_chapters" ADD CONSTRAINT "study_chapters_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
