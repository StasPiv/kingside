-- CreateTable
CREATE TABLE "puzzle_rush_session_puzzles" (
    "id" UUID NOT NULL,
    "score_id" UUID NOT NULL,
    "puzzle_id" TEXT NOT NULL,
    "solved" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "puzzle_rush_session_puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "puzzle_rush_session_puzzles_score_id_idx" ON "puzzle_rush_session_puzzles"("score_id");

-- AddForeignKey
ALTER TABLE "puzzle_rush_session_puzzles" ADD CONSTRAINT "puzzle_rush_session_puzzles_score_id_fkey" FOREIGN KEY ("score_id") REFERENCES "puzzle_rush_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "puzzle_rush_session_puzzles" ADD CONSTRAINT "puzzle_rush_session_puzzles_puzzle_id_fkey" FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
