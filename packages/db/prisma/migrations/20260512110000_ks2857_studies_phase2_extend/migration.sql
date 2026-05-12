-- KS-2856 / ADR-060 / KS-2857 (Wave A B1). Studies Phase 2 — расширение схемы.
--
-- Изменения:
--   1. `studies` — новые колонки: visibility, topics, likes, from_kind, from_ref_id.
--      Backfill visibility из is_public (true → 'public', false → 'private').
--      Поле is_public пока оставлено (DEPRECATED, удалит отдельная миграция
--      после раскатки фронта Phase 2).
--   2. `study_chapters` — новые колонки: conceal_ply, gamebook (JSONB).
--   3. Новые таблицы: study_members, study_likes.
--   4. Backfill study_members: owner-запись на каждую существующую студию
--      (иначе после введения members-системы владельцы потеряют доступ
--      через будущий B4 StudyAccessGuard).
--   5. Каталожные индексы по visibility — для B7 (Wave B) GET /catalog.
--
-- Миграция без даунтайма: ALTER TABLE ADD COLUMN с DEFAULT (Postgres
-- v11+ — fast path, без переписи rows); CREATE TABLE / INDEX —
-- inline IF NOT EXISTS не используем, миграция идемпотентна по
-- prisma_migrations bookkeeping.

-- ── studies: новые колонки ─────────────────────────────────────────
ALTER TABLE "studies" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "studies" ADD COLUMN "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "studies" ADD COLUMN "likes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "studies" ADD COLUMN "from_kind" TEXT NOT NULL DEFAULT 'scratch';
ALTER TABLE "studies" ADD COLUMN "from_ref_id" UUID;

-- Backfill visibility из is_public (для MVP-данных).
UPDATE "studies"
SET "visibility" = CASE WHEN "is_public" = TRUE THEN 'public' ELSE 'private' END;

-- ── study_chapters: новые колонки ──────────────────────────────────
ALTER TABLE "study_chapters" ADD COLUMN "conceal_ply" INTEGER;
ALTER TABLE "study_chapters" ADD COLUMN "gamebook" JSONB;

-- ── study_members ──────────────────────────────────────────────────
CREATE TABLE "study_members" (
    "study_id"  UUID NOT NULL,
    "user_id"   UUID NOT NULL,
    "role"      TEXT NOT NULL,
    "added_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_members_pkey" PRIMARY KEY ("study_id", "user_id")
);

CREATE INDEX "study_members_user_id_idx" ON "study_members"("user_id");

ALTER TABLE "study_members"
  ADD CONSTRAINT "study_members_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "study_members"
  ADD CONSTRAINT "study_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: каждый существующий owner → owner-запись в study_members.
-- Без этого после релиза Phase 2 владельцы своих студий перестанут
-- проходить guard (B4) на чтение/мутации.
INSERT INTO "study_members" ("study_id", "user_id", "role", "added_at")
SELECT "id", "owner_id", 'owner', NOW() FROM "studies"
ON CONFLICT ("study_id", "user_id") DO NOTHING;

-- ── study_likes ────────────────────────────────────────────────────
CREATE TABLE "study_likes" (
    "study_id"  UUID NOT NULL,
    "user_id"   UUID NOT NULL,
    "liked_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_likes_pkey" PRIMARY KEY ("study_id", "user_id")
);

CREATE INDEX "study_likes_user_id_idx" ON "study_likes"("user_id");

ALTER TABLE "study_likes"
  ADD CONSTRAINT "study_likes_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "study_likes"
  ADD CONSTRAINT "study_likes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Каталожные индексы (для B7 Wave B) ─────────────────────────────
CREATE INDEX "studies_visibility_updated_at_idx" ON "studies"("visibility", "updated_at");
CREATE INDEX "studies_visibility_likes_idx" ON "studies"("visibility", "likes");
CREATE INDEX "studies_visibility_created_at_idx" ON "studies"("visibility", "created_at");
