-- AlterTable
ALTER TABLE "arena_tournaments" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "arena_tournaments" ADD COLUMN "invite_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "arena_tournaments_invite_code_key" ON "arena_tournaments"("invite_code");

-- CreateTable
CREATE TABLE "tournament_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tournament_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tournament_invites_tournament_id_user_id_key" ON "tournament_invites"("tournament_id","user_id");

-- AddForeignKey
ALTER TABLE "tournament_invites" ADD CONSTRAINT "tournament_invites_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "arena_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
