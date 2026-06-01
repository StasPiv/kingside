-- KS-3551 / ADR-088 V3 §16 B0-v3. Blind Board V3 user-side state.
--
-- Добавляем в `users`:
--   `blind_board_best_level int NOT NULL DEFAULT 1`               — лучший
--      достигнутый уровень. Считается с учётом фактического
--      `levelDurationRounds` рекордной сессии; хранится отдельно, потому
--      что рекордную сессию могут удалить (KS-3530) и тогда
--      ретроспективно посчитать невозможно.
--   `blind_board_best_config_is_default bool NOT NULL DEFAULT true` —
--      `true` если рекорд был установлен на дефолтном `BlindBoardConfig`.
--      Используется leaderboard'ом для метки «эталонный режим».
--
-- Backfill:
--   1. `BlindBoardSession.start_config` (jsonb) — добавляем поля
--      `levelDurationRounds=10` и `progressionEnabled=true` тем записям,
--      где их ещё нет. До V3 эти поля не существовали; default V2
--      поведения — level-up каждые 10 раундов, прогрессия включена.
--   2. `users.blind_board_best_level = FLOOR(blind_board_best_streak / 10) + 1`.
--      Минимум 1 (streak=0 → level=1). Это формула V2-эры; для всех
--      существующих пользователей рекорды ставились на дефолте
--      (levelDurationRounds=10) — расчёт верный.
--   3. `users.blind_board_best_config_is_default = true` — у всех. До V3
--      другого конфига не существовало.

-- ── 1. Schema ─────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "blind_board_best_level" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "users"
  ADD COLUMN "blind_board_best_config_is_default" BOOLEAN NOT NULL DEFAULT true;

-- ── 2. Backfill BlindBoardSession.start_config ────────────────────────
-- jsonb_set с create_missing=true (default) добавляет ключи, если их нет;
-- если ключ уже есть — overwrites. Чтобы не затирать существующие
-- значения (если кто-то уже играл с кастомным V3-конфигом локально),
-- ставим guard через `?` (jsonb key exists).

UPDATE "blind_board_sessions"
SET "start_config" = jsonb_set("start_config", '{levelDurationRounds}', '10'::jsonb)
WHERE NOT ("start_config" ? 'levelDurationRounds');

UPDATE "blind_board_sessions"
SET "start_config" = jsonb_set("start_config", '{progressionEnabled}', 'true'::jsonb)
WHERE NOT ("start_config" ? 'progressionEnabled');

-- ── 3. Backfill users.blind_board_best_level ──────────────────────────
-- FLOOR(streak / 10) + 1. Для streak=0 даёт 1 (минимум). Default уже 1
-- покрывает новых юзеров; UPDATE обновляет тех, у кого реально были
-- streak'и.

UPDATE "users"
SET "blind_board_best_level" = FLOOR("blind_board_best_streak" / 10) + 1
WHERE "blind_board_best_streak" > 0;

-- ── 4. blind_board_best_config_is_default уже true для всех (default)
-- Никаких UPDATE'ов не требуется — column default=true применяется ко
-- всем существующим строкам при ADD COLUMN.
