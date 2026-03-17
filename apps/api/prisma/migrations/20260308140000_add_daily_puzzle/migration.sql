-- CreateTable
CREATE TABLE "daily_puzzles" (
    "id" UUID NOT NULL,
    "puzzle_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_puzzles_date_key" ON "daily_puzzles"("date");

-- AddForeignKey
ALTER TABLE "daily_puzzles" ADD CONSTRAINT "daily_puzzles_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
