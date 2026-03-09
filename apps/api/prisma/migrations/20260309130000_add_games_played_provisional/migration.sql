-- AlterTable
ALTER TABLE "users" ADD COLUMN "games_played_bullet" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "games_played_blitz" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "games_played_rapid" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "games_played_classical" INTEGER NOT NULL DEFAULT 0;
