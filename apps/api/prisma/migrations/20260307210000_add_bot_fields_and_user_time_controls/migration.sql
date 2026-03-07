-- AlterTable
ALTER TABLE "games" ADD COLUMN "bot_level" INTEGER,
ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_time_controls" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT,
    "initial_sec" INTEGER NOT NULL,
    "increment_sec" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_time_controls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_time_controls_user_id_idx" ON "user_time_controls"("user_id");

-- AddForeignKey
ALTER TABLE "user_time_controls" ADD CONSTRAINT "user_time_controls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
