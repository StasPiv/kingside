-- AlterEnum
ALTER TYPE "Termination" ADD VALUE 'abandon';

-- CreateIndex
CREATE INDEX "games_is_bot_status_idx" ON "games"("is_bot", "status");
