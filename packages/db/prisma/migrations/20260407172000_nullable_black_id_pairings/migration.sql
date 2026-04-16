-- Make black_id nullable in tournament_pairings (bye = null)
ALTER TABLE "tournament_pairings" ALTER COLUMN "black_id" DROP NOT NULL;
