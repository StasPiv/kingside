-- Fix puzzles.id type drift (uuid -> text) caused by prisma db push
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'puzzles' AND column_name = 'id' AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE "puzzle_attempts" DROP CONSTRAINT IF EXISTS "puzzle_attempts_puzzle_id_fkey";
    ALTER TABLE "puzzles" ALTER COLUMN "id" TYPE TEXT;
    ALTER TABLE "puzzle_attempts" ADD CONSTRAINT "puzzle_attempts_puzzle_id_fkey"
      FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable
CREATE TABLE "daily_puzzles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "puzzle_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_puzzles_date_key" ON "daily_puzzles"("date");

-- AddForeignKey
ALTER TABLE "daily_puzzles" ADD CONSTRAINT "daily_puzzles_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
