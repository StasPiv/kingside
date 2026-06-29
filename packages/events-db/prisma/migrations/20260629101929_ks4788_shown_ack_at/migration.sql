-- KS-4788 / ADR-151 §4.1. Поле `shown_ack_at` в actor_hint_states.
--
-- Семантика двух timestamp'ов разводится:
--   `last_shown_at`  — server-emit attempt (пишет HintsService.checkFor
--                      при primary матче).
--   `shown_ack_at`   — client confirmed render (пишет
--                      HintsController.shown/ignored — ack от клиента
--                      «popover отрисован» или «ttl истёк»).
--
-- Условие replay (HintsService.replayPending, §3): hint войдёт в выборку
-- если `shown_ack_at IS NULL OR shown_ack_at < last_shown_at`. Все
-- существующие строки получат `shown_ack_at = NULL` — на момент деплоя
-- это означает: подсказки, показанные за последние 60 секунд (окно
-- replay по умолчанию), при handshake будут реплеиться один раз. Это
-- безопасное поведение: типовой actor имеет <=1 строки в этом окне
-- (global throttle 600s), а frontend `<HintHost>` дедупит по hintId.
--
-- Индекс не добавляем: replayPending фильтрует по PK (actor_id, hint_id),
-- кардинальность state'ов на actor мала (десятки строк max). Поле
-- участвует только в `shown_ack_at IS NULL OR shown_ack_at < last_shown_at`
-- — на per-actor выборке порядка O(maxShows * activeHints), full-scan ок.

ALTER TABLE "events"."actor_hint_states"
  ADD COLUMN IF NOT EXISTS "shown_ack_at" TIMESTAMPTZ NULL;
