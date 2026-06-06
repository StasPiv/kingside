-- KS-3730 / ADR-110 §2.5, §5: live-трансляция анализа партии.
--
-- Метаданные хранятся в Postgres (id, slug, owner, status, тайминги,
-- viewerPeak). Текущая позиция и история ходов автора живут в Redis
-- (`live_analysis:<id>:state` hash и `live_analysis:<id>:moves` list,
-- TTL 24ч) — туда они уйдут в задачах KS-3732+.
--
-- Индексы:
--   * UNIQUE по slug (nanoid(10)) — защита от коллизий публичной ссылки.
--   * (owner_id, status) — «мои активные трансляции» в профиле автора.
--   * (status, last_activity_at) — cleanup-job (`@nestjs/schedule`)
--     каждые 5 минут отбирает active с last_activity_at < NOW() - 30 min
--     и переводит в closed (ADR-110 §2.3 B).

-- CreateEnum
CREATE TYPE "live_analysis_status" AS ENUM ('active', 'closed');

-- CreateTable
CREATE TABLE "live_analyses" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT,
    "starting_fen" TEXT,
    "status" "live_analysis_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewer_peak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "live_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_analyses_slug_key" ON "live_analyses"("slug");

-- CreateIndex
CREATE INDEX "live_analyses_owner_id_status_idx" ON "live_analyses"("owner_id", "status");

-- CreateIndex
CREATE INDEX "live_analyses_status_last_activity_at_idx" ON "live_analyses"("status", "last_activity_at");

-- AddForeignKey
ALTER TABLE "live_analyses" ADD CONSTRAINT "live_analyses_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
