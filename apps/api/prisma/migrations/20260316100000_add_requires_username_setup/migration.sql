-- AlterTable: make username nullable and add requires_username_setup
ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "requires_username_setup" BOOLEAN NOT NULL DEFAULT false;
