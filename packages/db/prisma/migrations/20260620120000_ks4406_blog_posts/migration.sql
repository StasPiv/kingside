-- KS-4406 / ADR-137 rev2. Блог kingside.site/blog: статьи живут в БД,
-- источник правды — backend. См. коммит архитектора 96d5480.

-- CreateTable
CREATE TABLE "blog_authors" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "avatar_url" TEXT,
    "bio_ru" TEXT,
    "bio_en" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "blog_authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "cover_url" TEXT,
    "cover_alt" TEXT,
    "tags" TEXT[],
    "related_route" TEXT,
    "reading_time_min" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blog_authors_handle_key" ON "blog_authors"("handle");

-- CreateIndex
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts"("status", "published_at" DESC);

-- CreateIndex
CREATE INDEX "blog_posts_slug_idx" ON "blog_posts"("slug");

-- CreateIndex
CREATE INDEX "blog_posts_tags_idx" ON "blog_posts" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "blog_posts_slug_locale_key" ON "blog_posts"("slug", "locale");

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "blog_authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: сидовый автор `handle='kingside'`. Идемпотентно — на повторный
-- запуск миграции (или ручной truncate) ON CONFLICT не выкинет.
INSERT INTO "blog_authors" ("id", "handle", "name_ru", "name_en", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'kingside', 'Kingside', 'Kingside', NOW(), NOW())
ON CONFLICT ("handle") DO NOTHING;
