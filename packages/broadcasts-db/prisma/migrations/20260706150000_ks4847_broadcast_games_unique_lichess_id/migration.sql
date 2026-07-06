-- KS-4847 / ADR-158 §2.2. Уникальность (round_id, lichess_game_id) в
-- broadcast_games — нужна для дедупликации upsert'ов из metadata-эндпоинта
-- /api/broadcast/-/-/{roundId} (§2.1) и из PGN-парсинга.
--
-- NULL'ы в lichess_game_id не участвуют в UNIQUE constraint (стандарт SQL:
-- NULL != NULL), поэтому старые записи с lichess_game_id IS NULL не
-- препятствуют миграции. Записи с одинаковым не-NULL lichess_game_id в
-- одном round_id не наблюдались (KS-3229 очистил их); при необходимости
-- индекс упадёт с явной ошибкой — предпочтительнее, чем молча удалять данные.
CREATE UNIQUE INDEX "broadcast_games_round_id_lichess_game_id_key"
  ON "broadcast_games" ("round_id", "lichess_game_id");
