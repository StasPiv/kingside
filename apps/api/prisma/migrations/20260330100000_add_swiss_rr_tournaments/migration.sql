-- AlterTable: extend ArenaTournament
ALTER TABLE "arena_tournaments" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'arena';
ALTER TABLE "arena_tournaments" ADD COLUMN "total_rounds" INTEGER;
ALTER TABLE "arena_tournaments" ADD COLUMN "round_pause_min" INTEGER;
ALTER TABLE "arena_tournaments" ADD COLUMN "max_players" INTEGER;
ALTER TABLE "arena_tournaments" ADD COLUMN "current_round" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: TournamentRound
CREATE TABLE "tournament_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "round_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "tournament_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TournamentPairing
CREATE TABLE "tournament_pairings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "round_id" UUID NOT NULL,
    "white_id" UUID NOT NULL,
    "black_id" UUID,
    "game_id" UUID,
    "result" TEXT,
    "board" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "tournament_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tournament_rounds_tournament_id_round_number_key" ON "tournament_rounds"("tournament_id", "round_number");
CREATE INDEX "tournament_pairings_round_id_idx" ON "tournament_pairings"("round_id");

-- AddForeignKey
ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_tournament_id_fkey"
    FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_pairings" ADD CONSTRAINT "tournament_pairings_round_id_fkey"
    FOREIGN KEY ("round_id") REFERENCES "tournament_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
