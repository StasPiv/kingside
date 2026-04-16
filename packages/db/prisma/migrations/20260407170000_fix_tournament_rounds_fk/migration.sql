-- Fix FK: tournament_rounds.tournament_id should reference arena_tournaments, not tournaments
DO $$
BEGIN
  -- Only fix if the FK currently references the wrong table
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON c.confrelid = r.oid
    WHERE c.conname = 'tournament_rounds_tournament_id_fkey'
    AND r.relname = 'tournaments'
  ) THEN
    ALTER TABLE "tournament_rounds" DROP CONSTRAINT "tournament_rounds_tournament_id_fkey";
    ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_tournament_id_fkey"
      FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
