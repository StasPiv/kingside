-- KS-4026 / ADR-122. Переезд хранения позиционной трассы с привязки
-- к партии (KS-4023, `game_positional_traces`) на привязку к анализу
-- (`analysis_positional_traces`).
--
-- Причина (см. описание KS-4026): в реальном потоке пользователя
-- (включая «Открыть в анализе» из Архива) `gameId` почти всегда
-- отсутствует — все партии идут через `openAnalysisFromPgn` →
-- создаётся новый `Analysis`, `gameId` не сохраняется. Старая
-- таблица `game_positional_traces` в проде не успела наполниться
-- данными, поэтому миграция данных не требуется — просто DROP.
--
-- Замечание про shadow-database (см. KS-3930, KS-4008, KS-4023):
-- `prisma migrate dev` падает на legacy KS-3234 в shadow-БД, поэтому
-- миграция написана вручную; на проде применяется `prisma migrate
-- deploy` через `kingside-api-migrations`.

DROP TABLE IF EXISTS "game_positional_traces";

CREATE TABLE "analysis_positional_traces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "analysis_id" UUID NOT NULL,
    "sf_version" VARCHAR(64) NOT NULL,
    "plies" JSONB NOT NULL,
    "duration_ms" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_positional_traces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analysis_positional_traces_analysis_id_key"
    ON "analysis_positional_traces"("analysis_id");

ALTER TABLE "analysis_positional_traces"
    ADD CONSTRAINT "analysis_positional_traces_analysis_id_fkey"
    FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "analysis_positional_traces"
    ADD CONSTRAINT "analysis_positional_traces_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
