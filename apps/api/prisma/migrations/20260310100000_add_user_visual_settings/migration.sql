-- AlterTable
ALTER TABLE "users" ADD COLUMN "board_theme" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "users" ADD COLUMN "piece_set" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "users" ADD COLUMN "sound_enabled" BOOLEAN NOT NULL DEFAULT true;
