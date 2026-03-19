-- CreateTable
CREATE TABLE "live_tournaments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "chess_results_id" TEXT NOT NULL,
    "chess_results_url" TEXT NOT NULL,
    "livechess_uuid" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_tournaments_chess_results_id_key" ON "live_tournaments"("chess_results_id");

-- CreateIndex
CREATE INDEX "live_tournaments_livechess_uuid_idx" ON "live_tournaments"("livechess_uuid");
