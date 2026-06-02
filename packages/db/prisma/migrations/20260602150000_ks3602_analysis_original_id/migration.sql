-- KS-3602 / ADR-100 §8.2. NAG auto-annotation: «Разобрать партию» через
-- Stockfish+Maia создаёт новую копию Analysis с авто-NAG'ами и variations,
-- оригинал не трогается. Дубль помечается soft-ссылкой
-- `original_analysis_id` → id оригинала.
--
-- Без FK — оригинал может быть удалён пользователем; дубль остаётся
-- висячим (фронт обрабатывает 410 на повторную регенерацию).
--
-- Идемпотентность duplicate-annotated endpoint'а реализована в коде
-- (findFirst по (userId, originalAnalysisId) + update/create); UNIQUE
-- здесь НЕ ставим намеренно — избегаем 409 на race (см. ADR-100 §8.4 и
-- описание задачи KS-3602 §«Не делать»).
--
-- Индекс `(user_id, original_analysis_id)` нужен для:
--  1. findFirst в duplicate-annotated (поиск существующего дубля).
--  2. potential `GET /analyses/:id` показ «← Исходный анализ» (resolve).

ALTER TABLE "analyses"
  ADD COLUMN "original_analysis_id" UUID;

CREATE INDEX "analyses_user_id_original_analysis_id_idx"
  ON "analyses"("user_id", "original_analysis_id");
