-- KS-4309: Серверного бота на проекте не будет.
-- Поле `bot_client_side` стало мёртвым флагом — для одной ветки создания
-- bot-партии всегда `true`, для другой всегда `false` (контроллер не
-- передавал `wasmSupported`). Фронт зависимость уже снял (KS-4308).
ALTER TABLE "games" DROP COLUMN IF EXISTS "bot_client_side";
