-- CreateTable
CREATE TABLE "game_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 18,
    "white_accuracy" DOUBLE PRECISION NOT NULL,
    "black_accuracy" DOUBLE PRECISION NOT NULL,
    "moves" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_reports_game_id_key" ON "game_reports"("game_id");

-- CreateIndex
CREATE INDEX "game_reports_game_id_idx" ON "game_reports"("game_id");

-- AddForeignKey
ALTER TABLE "game_reports" ADD CONSTRAINT "game_reports_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
