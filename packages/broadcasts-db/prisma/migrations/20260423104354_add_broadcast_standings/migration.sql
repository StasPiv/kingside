-- KS-1725 / ADR-023 §2.3: chess-results crosstable cache.
--
-- Добавляет:
--   1) `broadcasts.chess_results_tournament_id` (TEXT, nullable) — id турнира на
--      chess-results.com, извлекается из `standings_url` regex'ом
--      `/tnr(\d+)\.aspx/` при upsert'е broadcast'а из Lichess sync (ADR-023
--      §2.2.2). Хранится строкой (не числом): внешняя система, формат может
--      измениться.
--   2) Таблица `broadcast_standings` — 1:1 с broadcasts. JSON-payload типа-
--      specific (round-robin → raw_cross_table, swiss → raw_pairings,
--      team-* → raw_teams). `raw_players` всегда заполнен. Писатель —
--      ChessResultsCrosstableService (broadcast-service, ADR-023 §2.9.1),
--      upsert по broadcast_id. Чтение — GET /broadcasts/:id/crosstable.
--   3) Индекс по `stale_at` — для будущего background-refresh job'а
--      (TTL 5min/1h/24h по lifecycle, ADR-023 §2.8).

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN "chess_results_tournament_id" TEXT;

-- CreateTable
CREATE TABLE "broadcast_standings" (
    "id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT,
    "tournament_type" TEXT NOT NULL,
    "raw_players" JSONB NOT NULL,
    "raw_cross_table" JSONB,
    "raw_pairings" JSONB,
    "raw_teams" JSONB,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "stale_at" TIMESTAMP(3) NOT NULL,
    "fetch_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_standings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_standings_broadcast_id_key" ON "broadcast_standings"("broadcast_id");

-- CreateIndex
CREATE INDEX "broadcast_standings_stale_at_idx" ON "broadcast_standings"("stale_at");

-- AddForeignKey
ALTER TABLE "broadcast_standings" ADD CONSTRAINT "broadcast_standings_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
