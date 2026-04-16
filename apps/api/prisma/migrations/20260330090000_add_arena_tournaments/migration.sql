-- AlterTable: add tournamentId to games
ALTER TABLE "games" ADD COLUMN "tournament_id" UUID;

-- CreateTable: ArenaTournament
CREATE TABLE "arena_tournaments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "time_control_type" TEXT NOT NULL,
    "time_initial_sec" INTEGER NOT NULL,
    "time_increment_sec" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "finishes_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "arena_tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ArenaTournamentEntry
CREATE TABLE "arena_tournament_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "arena_tournament_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "arena_tournaments_status_idx" ON "arena_tournaments"("status");
CREATE INDEX "arena_tournaments_starts_at_idx" ON "arena_tournaments"("starts_at");
CREATE INDEX "games_tournament_id_idx" ON "games"("tournament_id");
CREATE UNIQUE INDEX "arena_tournament_entries_tournament_id_user_id_key" ON "arena_tournament_entries"("tournament_id", "user_id");
CREATE INDEX "arena_tournament_entries_tournament_id_score_idx" ON "arena_tournament_entries"("tournament_id", "score");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "arena_tournament_entries" ADD CONSTRAINT "arena_tournament_entries_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
