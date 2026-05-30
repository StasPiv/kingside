-- KS-3485 / ADR-088 V2 §15 B0. Прогрессивная сложность blind-board.
--
-- Добавляем:
--   `level int NOT NULL DEFAULT 1`         — текущий уровень сессии.
--   `start_config jsonb NOT NULL DEFAULT ...` — snapshot BlindBoardConfig.
--
-- Backfill существующих legacy-сессий: default value сам проставит
-- level=1 и start_config = DEFAULT_BLIND_BOARD_CONFIG (Q+N+R, addOrder
-- B,B,R,N, memorizeTimeSec=5). Legacy-сессии играются по 5 фигур
-- (Q/R/N/B/B); их `start_position` останется как был, но новый
-- start_config описывает «как должно было быть» — фронту хватит для
-- UI «уровень/доска». На submitAnswer level-up для legacy не сработает
-- (level=1 → addOrder[0]=B — попытка добавить ещё одного B на доску где
-- их уже 2 будет отвергнута квотой). Поведение для уже завершённых
-- сессий не меняется.
--
-- Для лидерборда maxLevel вычисляется backend'ом как
-- `floor(bestStreak / 10) + 1` (derive по architect-recommendation,
-- отдельная колонка не нужна).

ALTER TABLE "blind_board_sessions"
  ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "blind_board_sessions"
  ADD COLUMN "start_config" JSONB NOT NULL
    DEFAULT '{"startPieces":["Q","N","R"],"addOrder":["B","B","R","N"],"memorizeTimeSec":5}'::jsonb;
