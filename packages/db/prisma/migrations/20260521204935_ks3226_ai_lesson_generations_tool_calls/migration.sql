-- KS-3226 / ADR-075 §7 B6. Расширяем audit-таблицу
-- `ai_lesson_generations` опциональным `tool_calls JSONB` — массив
-- tool-call'ов, которые сделала Anthropic-сессия для одной генерации
-- курса (включая non-create_user_course инструменты: lessons, steps,
-- puzzles, drills, …).
--
-- Поле nullable: исторические записи остаются с NULL, новые
-- может заполняться webhook'ом / backend'ом по мере накопления вызовов
-- (см. KS-3226 — webhook-server.py пока пишет одну запись на
-- create_user_course, расширение до полного журнала — следующий этап).

ALTER TABLE "ai_lesson_generations"
  ADD COLUMN "tool_calls" JSONB;

-- Индекс GIN по tool_calls — для аналитики «какие инструменты чаще
-- всего ассистент использует». Partial: WHERE tool_calls IS NOT NULL,
-- чтобы не тратить индекс на NULL-row'ы.
CREATE INDEX "ai_lesson_generations_tool_calls_idx"
  ON "ai_lesson_generations"
  USING GIN ("tool_calls")
  WHERE "tool_calls" IS NOT NULL;
