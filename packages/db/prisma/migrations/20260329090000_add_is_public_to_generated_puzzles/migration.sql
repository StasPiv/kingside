-- AlterTable
ALTER TABLE "generated_puzzles" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "generated_puzzles_is_public_idx" ON "generated_puzzles"("is_public");
