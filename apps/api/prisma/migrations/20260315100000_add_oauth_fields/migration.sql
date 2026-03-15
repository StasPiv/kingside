-- AlterTable: make email and passwordHash nullable, add OAuth fields
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "oauth_provider" TEXT;
ALTER TABLE "users" ADD COLUMN "oauth_provider_id" TEXT;

-- CreateIndex: unique constraint on oauth_provider + oauth_provider_id
CREATE UNIQUE INDEX "users_oauth_provider_oauth_provider_id_key"
  ON "users"("oauth_provider", "oauth_provider_id");
