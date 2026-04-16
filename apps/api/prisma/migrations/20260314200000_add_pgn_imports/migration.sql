-- CreateTable
CREATE TABLE "pgn_imports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pgn_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pgn_import_games" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "pgn" TEXT NOT NULL,
    "white" TEXT,
    "black" TEXT,
    "result" TEXT,
    "date" TEXT,
    "opening" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "pgn_import_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pgn_imports_user_id_idx" ON "pgn_imports"("user_id");

-- CreateIndex
CREATE INDEX "pgn_import_games_import_id_idx" ON "pgn_import_games"("import_id");

-- AddForeignKey
ALTER TABLE "pgn_imports" ADD CONSTRAINT "pgn_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pgn_import_games" ADD CONSTRAINT "pgn_import_games_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "pgn_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
