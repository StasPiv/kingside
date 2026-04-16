-- CreateTable
CREATE TABLE "generated_puzzle_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "puzzle_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "solved" BOOLEAN NOT NULL,
    "time_ms" INTEGER NOT NULL,
    "user_rating_before" INTEGER NOT NULL,
    "user_rating_after" INTEGER NOT NULL,
    "puzzle_rating_before" INTEGER NOT NULL,
    "puzzle_rating_after" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_puzzle_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generated_puzzle_attempts_puzzle_id_idx" ON "generated_puzzle_attempts"("puzzle_id");
CREATE INDEX "generated_puzzle_attempts_user_id_idx" ON "generated_puzzle_attempts"("user_id");

-- AddForeignKey
ALTER TABLE "generated_puzzle_attempts" ADD CONSTRAINT "generated_puzzle_attempts_puzzle_id_fkey"
    FOREIGN KEY ("puzzle_id") REFERENCES "generated_puzzles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
