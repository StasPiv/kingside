-- KS-2373: статистика посещений разделов для динамического
-- MobileBottomBar (топ-3 разделы → нижняя панель мобильной версии).
--
-- Хранится на сервере (cross-device).

CREATE TABLE "user_nav_stats" (
  "user_id"    UUID         NOT NULL,
  "route"      TEXT         NOT NULL,
  "count"      INTEGER      NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_nav_stats_pkey" PRIMARY KEY ("user_id", "route")
);

ALTER TABLE "user_nav_stats"
  ADD CONSTRAINT "user_nav_stats_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Индекс для top-N запроса: WHERE user_id=$1 ORDER BY count DESC LIMIT N.
CREATE INDEX "user_nav_stats_user_id_count_idx"
  ON "user_nav_stats" ("user_id", "count" DESC);
