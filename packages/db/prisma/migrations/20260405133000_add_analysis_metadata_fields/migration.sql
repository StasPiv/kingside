-- AlterTable
ALTER TABLE "analyses" ADD COLUMN "site" TEXT;
ALTER TABLE "analyses" ADD COLUMN "pgn_date" TEXT;
ALTER TABLE "analyses" ADD COLUMN "round" TEXT;
ALTER TABLE "analyses" ADD COLUMN "white" TEXT;
ALTER TABLE "analyses" ADD COLUMN "black" TEXT;
ALTER TABLE "analyses" ADD COLUMN "white_elo" TEXT;
ALTER TABLE "analyses" ADD COLUMN "black_elo" TEXT;
ALTER TABLE "analyses" ADD COLUMN "result" TEXT;
