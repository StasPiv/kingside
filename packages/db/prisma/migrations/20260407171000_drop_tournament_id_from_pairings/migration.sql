-- Drop tournament_id from tournament_pairings if it exists (not in Prisma schema, causes NOT NULL violation)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tournament_pairings' AND column_name = 'tournament_id'
  ) THEN
    ALTER TABLE "tournament_pairings" DROP COLUMN "tournament_id";
  END IF;
END $$;
