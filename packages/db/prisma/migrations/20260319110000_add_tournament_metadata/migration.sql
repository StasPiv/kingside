-- AlterTable
ALTER TABLE "live_tournaments" ADD COLUMN "description" TEXT;
ALTER TABLE "live_tournaments" ADD COLUMN "location" TEXT;
ALTER TABLE "live_tournaments" ADD COLUMN "time_control" TEXT;
ALTER TABLE "live_tournaments" ADD COLUMN "player_count" INTEGER;
ALTER TABLE "live_tournaments" ADD COLUMN "start_date" TEXT;
ALTER TABLE "live_tournaments" ADD COLUMN "end_date" TEXT;
