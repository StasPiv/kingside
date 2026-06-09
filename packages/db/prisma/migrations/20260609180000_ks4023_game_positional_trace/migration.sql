-- KS-4023 / ADR-122 §4. Кеш позиционных метрик SF-trace по партии.
-- Одна запись на партию (UNIQUE gameId), JSONB-массив полуходов
-- ({ ply, subterms[], phase? }). Размер тела ограничивается на стороне
-- валидатора NestJS (256 КБ), на стороне БД ограничений нет — JSONB
-- + TOAST автоматически жмёт большие тела.
--
-- Cascade-delete от games: запись бессмысленна без своей партии.
-- created_by_id (FK users SetNull) хранит автора расчёта для
-- аналитики, не для авторизации (права регулируются на стороне
-- контроллера через JwtAuthGuard + проверку владельца партии).
--
-- Замечание про shadow-database (см. соседнюю миграцию KS-3930):
-- `prisma migrate dev` падает на legacy KS-3234 в shadow-БД из-за
-- отсутствия pg_trgm. Поэтому миграция написана вручную; на проде
-- применяется `prisma migrate deploy` через `kingside-api-migrations`.

CREATE TABLE "game_positional_traces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "sf_version" VARCHAR(64) NOT NULL,
    "plies" JSONB NOT NULL,
    "duration_ms" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_positional_traces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_positional_traces_game_id_key"
    ON "game_positional_traces"("game_id");

ALTER TABLE "game_positional_traces"
    ADD CONSTRAINT "game_positional_traces_game_id_fkey"
    FOREIGN KEY ("game_id") REFERENCES "games"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "game_positional_traces"
    ADD CONSTRAINT "game_positional_traces_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
