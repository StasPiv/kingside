-- AlterTable
ALTER TABLE "live_tournaments" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "live_tournaments" ADD COLUMN "total_rounds" INTEGER;
