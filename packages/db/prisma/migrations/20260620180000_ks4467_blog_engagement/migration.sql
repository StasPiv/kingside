-- KS-4467 / ADR-140 T1. Фундамент для blog-engagement:
--   * денормализованные счётчики `views_count`, `likes_count`,
--     `comments_count` в `blog_posts` — для быстрой отдачи карточек
--     ленты и страницы статьи без агрегатов;
--   * таблица `blog_post_likes` — один лайк = (post_id, user_id),
--     индекс по user_id под будущий list «лайкнутые мной»;
--   * таблица `blog_post_comments` — плоская лента комментариев,
--     soft-delete через `deleted_at`, индекс под cursor-пагинацию
--     `(post_id, created_at DESC, id DESC)`.
--
-- onDelete:
--   blog_post_likes.post_id   → CASCADE   (статья → лайки)
--   blog_post_likes.user_id   → CASCADE   (юзер → лайки)
--   blog_post_comments.post_id → CASCADE  (статья → комментарии)
--   blog_post_comments.user_id → RESTRICT (нельзя снести юзера с
--                                          неудалёнными комментариями)
--
-- Backfill: счётчики стартуют с 0 для всех существующих статей —
-- к моменту T1 в `blog_post_likes` / `blog_post_comments` записей
-- не было (таблиц не существовало). T7-cron в первом запуске
-- подтвердит, что COUNT(*) совпадает с denorm.

-- AlterTable
ALTER TABLE "blog_posts"
  ADD COLUMN "views_count"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "likes_count"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "comments_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "blog_post_likes" (
    "post_id"    UUID         NOT NULL,
    "user_id"    UUID         NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_post_likes_pkey" PRIMARY KEY ("post_id", "user_id")
);

-- CreateIndex
CREATE INDEX "blog_post_likes_user_id_idx" ON "blog_post_likes"("user_id");

-- CreateTable
CREATE TABLE "blog_post_comments" (
    "id"         UUID           NOT NULL,
    "post_id"    UUID           NOT NULL,
    "user_id"    UUID           NOT NULL,
    "body"       TEXT           NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "blog_post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blog_post_comments_post_id_created_at_id_idx"
  ON "blog_post_comments"("post_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "blog_post_comments_user_id_idx" ON "blog_post_comments"("user_id");

-- AddForeignKey
ALTER TABLE "blog_post_likes"
  ADD CONSTRAINT "blog_post_likes_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_likes"
  ADD CONSTRAINT "blog_post_likes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_comments"
  ADD CONSTRAINT "blog_post_comments_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_comments"
  ADD CONSTRAINT "blog_post_comments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
