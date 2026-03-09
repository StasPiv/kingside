-- AlterEnum
ALTER TYPE "Termination" ADD VALUE 'abandon';

-- AlterTable
ALTER TABLE "games" ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "games_is_bot_status_idx" ON "games"("is_bot", "status");
