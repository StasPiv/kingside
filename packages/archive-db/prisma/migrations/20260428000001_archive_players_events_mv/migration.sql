-- KS-2064 / ADR-033 §4.4:
-- Нормализованные таблицы под полнотекстовый поиск имён игроков и турниров,
-- pg_trgm GIN-индексы, материализованный view профиля игрока.
--
-- Заполняется one-shot backfill'ом
-- (`apps/archive-service/src/cli/backfill-players-events.ts`) и
-- инкрементальным апдейтом в archive-importer после каждого успешного
-- импорта TWIC issue.

-- ─── Extension ───────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── archive_players ─────────────────────────────────────────────────

CREATE TABLE "archive_players" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "name_canonical" TEXT NOT NULL,
  "name_normalized" TEXT NOT NULL,
  "name_aliases" TEXT NOT NULL,
  "games_count" INTEGER NOT NULL DEFAULT 0,
  "peak_elo" INTEGER,
  "first_seen_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "archive_players_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "archive_players_slug_key" ON "archive_players"("slug");
CREATE INDEX "archive_players_name_normalized_idx" ON "archive_players"("name_normalized");
CREATE INDEX "archive_players_games_count_idx" ON "archive_players"("games_count" DESC);

-- GIN trgm для FTS по всем алиасам:
--   pg_trgm operator `%` и `similarity()` используются ранжированием
--   (см. ADR-033 §4.4.4). `name_aliases` агрегирует все встретившиеся
--   формы имени через ", " — индексировать по нему даёт максимальный
--   recall (запрос «carls» матчит «Carlsen», «Carlsen, M.», «M.Carlsen» и т.п.).
CREATE INDEX "archive_players_aliases_trgm"
  ON "archive_players" USING GIN ("name_aliases" gin_trgm_ops);

-- ─── archive_events ──────────────────────────────────────────────────

CREATE TABLE "archive_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "name_canonical" TEXT NOT NULL,
  "name_normalized" TEXT NOT NULL,
  "games_count" INTEGER NOT NULL DEFAULT 0,
  "first_date" TEXT,
  "last_date" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "archive_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "archive_events_slug_key" ON "archive_events"("slug");
CREATE INDEX "archive_events_games_count_idx" ON "archive_events"("games_count" DESC);
CREATE INDEX "archive_events_name_trgm"
  ON "archive_events" USING GIN ("name_normalized" gin_trgm_ops);

-- ─── archive_player_stats (materialized view) ────────────────────────
--
-- Профиль игрока: количество партий, цвет, результат, peak_elo, первая/
-- последняя партия. JOIN по `name_canonical` — это та же форма, которую
-- используют `archive_games.white_name`/`black_name` (источник `tagName`
-- из PGN, без нормализации). UNIQUE INDEX на `slug` — обязательное
-- условие для `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
--
-- ВНИМАНИЕ: `peak_elo` берёт elo стороны самого игрока в каждой партии
-- (ADR-033 §4.4.6 показывает шорткат `MAX(GREATEST(white_elo, black_elo))`,
-- который вернул бы elo соперника, если тот был сильнее — это делает
-- метрику бесполезной для профиля «Magnus Carlsen, peak ~2882» если он
-- играл с Карлсеном №2). Реализовано корректно через CASE.
--
-- `result_for_player(g, p)` в ADR — концептуальный плейсхолдер; здесь
-- развёрнут в inline-CASE.
CREATE MATERIALIZED VIEW "archive_player_stats" AS
SELECT
  p.slug,
  COUNT(*)::int AS games_count,
  COUNT(*) FILTER (WHERE g.white_name = p.name_canonical)::int AS games_white,
  COUNT(*) FILTER (WHERE g.black_name = p.name_canonical)::int AS games_black,
  COUNT(*) FILTER (
    WHERE (g.white_name = p.name_canonical AND g.result = '1-0')
       OR (g.black_name = p.name_canonical AND g.result = '0-1')
  )::int AS wins,
  COUNT(*) FILTER (WHERE g.result = '1/2-1/2')::int AS draws,
  COUNT(*) FILTER (
    WHERE (g.white_name = p.name_canonical AND g.result = '0-1')
       OR (g.black_name = p.name_canonical AND g.result = '1-0')
  )::int AS losses,
  MAX(
    CASE
      WHEN g.white_name = p.name_canonical THEN g.white_elo
      WHEN g.black_name = p.name_canonical THEN g.black_elo
      ELSE NULL
    END
  ) AS peak_elo,
  MIN(g.played_at) AS first_seen_at,
  MAX(g.played_at) AS last_seen_at
FROM archive_players p
JOIN archive_games g
  ON g.white_name = p.name_canonical OR g.black_name = p.name_canonical
GROUP BY p.slug;

CREATE UNIQUE INDEX "archive_player_stats_slug_key"
  ON "archive_player_stats" ("slug");
