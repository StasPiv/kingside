-- CreateTable
CREATE TABLE "game_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "analysis_pgn" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_analyses_game_id_idx" ON "game_analyses"("game_id");

-- CreateIndex
CREATE INDEX "game_analyses_user_id_idx" ON "game_analyses"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_analyses_game_id_user_id_key" ON "game_analyses"("game_id", "user_id");

-- AddForeignKey
ALTER TABLE "game_analyses" ADD CONSTRAINT "game_analyses_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_analyses" ADD CONSTRAINT "game_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
