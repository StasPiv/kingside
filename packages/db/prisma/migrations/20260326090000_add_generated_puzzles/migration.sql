-- CreateTable
CREATE TABLE "generated_puzzles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fen" TEXT NOT NULL,
    "moves" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1500,
    "rating_dev" INTEGER NOT NULL DEFAULT 350,
    "themes" TEXT NOT NULL DEFAULT '',
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_move_num" INTEGER,
    "gap" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 18,
    "created_by" UUID,
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "nb_plays" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_puzzles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generated_puzzles_rating_idx" ON "generated_puzzles"("rating");
CREATE INDEX "generated_puzzles_themes_idx" ON "generated_puzzles"("themes");
CREATE INDEX "generated_puzzles_source_type_source_id_idx" ON "generated_puzzles"("source_type", "source_id");
CREATE INDEX "generated_puzzles_created_by_idx" ON "generated_puzzles"("created_by");
