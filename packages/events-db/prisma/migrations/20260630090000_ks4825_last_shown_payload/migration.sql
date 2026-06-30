-- KS-4825 / ADR-154 §2.2. Snapshot готового `HintShowPayload` после
-- серверной подстановки `{{var}}` в `HintsService.checkFor`.
--
-- Используется `HintsService.replayPending` (ADR-151): при reconnect
-- клиента в окне `replayWindowSec` возвращается ТОТ ЖЕ payload, что
-- упустил клиент. Пересборка через `toShowPayload(hint, locale)` без
-- знания триггера давала бы битый `ctaHref` (`{{game_id}}` буквально
-- или fallback) — UX хуже, чем не показывать.
--
-- Для строк, созданных до миграции, поле = NULL; код берёт fallback
-- `toShowPayload(hint, locale)`. На практике эти строки старше 60с и
-- replay-окно их не выбирает.
--
-- Индекс не нужен: чтение/запись идёт по PK `(actor_id, hint_id)`,
-- JSON не фильтруется на этом уровне.

ALTER TABLE "events"."actor_hint_states"
  ADD COLUMN IF NOT EXISTS "last_shown_payload" JSONB NULL;
